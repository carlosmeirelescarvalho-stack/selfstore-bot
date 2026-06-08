// index.js — servidor principal

const express = require('express')
const config = require('./config')
const { handleCadastro, sincronizarComIDFace } = require('./cadastro')
const { handleAdmin, isAdmin } = require('./admin-whatsapp')
const { previewPlanilha, importarPlanilha, cadastrarManual } = require('./importacao')
const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const { handleGeladeira, isComandoGeladeira } = require('./geladeira')
const { enviarTexto, MSG } = require('./whatsapp')
const db = require('./db')

const app = express()
app.use(express.json({ limit: '20mb' })) // imagens chegam em base64

// ─── WEBHOOK — recebe mensagens do WhatsApp via Evolution API ─────
app.post('/webhook', async (req, res) => {
  // Responde imediatamente — Evolution API não aguarda processamento
  res.sendStatus(200)

  try {
    const evento = req.body

    // Filtra apenas mensagens recebidas (ignora status, notificações internas)
    if (evento.event !== 'messages.upsert') return
    const msg = evento.data?.message
    if (!msg) return

    // Ignora mensagens enviadas pelo próprio bot
    if (evento.data?.key?.fromMe) return

    // Extrai dados da mensagem
    const celular = evento.data?.key?.remoteJid?.replace('@s.whatsapp.net', '')
    if (!celular) return

    // Ignora grupos
    if (celular.includes('@g.us')) return

    const tipoMensagem = detectarTipo(msg)
    const textoMensagem = extrairTexto(msg, tipoMensagem)
    const imagemBase64 = tipoMensagem === 'image'
      ? msg.imageMessage?.jpegThumbnail || null
      : null

    // ── ROTEAMENTO ──────────────────────────────────────────────

    // Verifica se é admin com sessão ativa ou digitou ADMIN
    const adminAutorizado = await isAdmin(celular)
    if (adminAutorizado) {
      const sessaoAdmin = await db.buscarSessao('admin_' + celular)
      const { isComandoAdmin } = require('./admin-whatsapp')
      if (sessaoAdmin || isComandoAdmin(textoMensagem)) {
        const resultado = await handleAdmin(celular, textoMensagem, tipoMensagem, imagemBase64)
        if (resultado !== 'continuar') return
        // Se retornou 'continuar', cai no fluxo normal de morador abaixo
      }
    }

    // Comando de abertura de geladeira (vem do QR Code)
    if (tipoMensagem === 'text' && isComandoGeladeira(textoMensagem)) {
      await handleGeladeira(celular, textoMensagem)
      return
    }

    // Palavras-chave para cadastro explícito
    const textUpper = textoMensagem.toUpperCase().trim()
    const isCadastro = ['2', 'CADASTRO', 'CADASTRAR', 'OI', 'OLÁ', 'OLA', 'INICIO', 'INÍCIO', 'START']
      .includes(textUpper)

    if (isCadastro || tipoMensagem === 'image') {
      // Verifica se já tem sessão de cadastro ativa
      const sessao = await db.buscarSessao(celular)
      if (sessao || isCadastro || tipoMensagem === 'image') {
        await handleCadastro(celular, textoMensagem, tipoMensagem, imagemBase64)
        return
      }
    }

    // Opção 1 do menu — sem sessão ativa e sem QR Code
    if (textUpper === '1') {
      await enviarTexto(
        celular,
        `📷 Para abrir a geladeira, aponte a câmera do seu celular para o *QR Code* colado na geladeira.\n\nÉ rápido e simples! 😊`
      )
      return
    }

    // Sessão de cadastro ativa — continua o fluxo
    const sessaoAtiva = await db.buscarSessao(celular)
    if (sessaoAtiva) {
      await handleCadastro(celular, textoMensagem, tipoMensagem, imagemBase64)
      return
    }

    // Mensagem não reconhecida — exibe menu geral
    await enviarTexto(celular, MSG.naoEntendido())

  } catch (err) {
    console.error('Erro no webhook:', err)
  }
})

// ─── WEBHOOK DO iDFace — recebe eventos de acesso facial ──────────
app.post('/webhook/idface', async (req, res) => {
  res.sendStatus(200)
  try {
    const evento = req.body
    // O iDFace envia: { user_id, name, timestamp, door, result }
    if (!evento.user_id) return

    await db.registrarLog(
      evento.user_id,
      null, // geladeira_id não se aplica ao facial
      'facial',
      evento.result === 'granted' ? 'aberto' : 'negado',
      evento.result !== 'granted' ? evento.result : null
    )
  } catch (err) {
    console.error('Erro no webhook iDFace:', err)
  }
})

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }))


// ─── ENDPOINTS PAINEL ADMIN ───────────────────────────────────────

// GET /admin/moradores — lista moradores com filtros
app.get('/admin/moradores', async (req, res) => {
  try {
    const { status, busca, limit = 50, offset = 0 } = req.query
    const { createClient } = require('@supabase/supabase-js')
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    let query = supa.from('moradores').select('*, condominios(nome)', { count: 'exact' })
    if (status && status !== 'todos') query = query.eq('status', status)
    if (busca) query = query.or(`nome.ilike.%${busca}%,cpf.ilike.%${busca}%,unidade.ilike.%${busca}%`)
    query = query.order('criado_em', { ascending: false }).range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)
    const { data, error, count } = await query
    if (error) throw error
    res.json({ moradores: data, total: count })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// PATCH /admin/moradores/:id — atualiza status
app.patch('/admin/moradores/:id', async (req, res) => {
  try {
    const { status } = req.body
    const morador = await db.atualizarStatusMorador(req.params.id, status)
    res.json({ morador })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// POST /admin/moradores — cadastro manual
app.post('/admin/moradores', async (req, res) => {
  try {
    const resultado = await cadastrarManual(req.body)
    if (resultado.erro) return res.status(400).json({ erro: resultado.erro })
    res.json(resultado)
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// POST /admin/importar/preview — preview da planilha
app.post('/admin/importar/preview', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' })
    const { condominio_id } = req.body
    const preview = await previewPlanilha(req.file.buffer, condominio_id)
    res.json(preview)
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// POST /admin/importar/confirmar — confirma importação
app.post('/admin/importar/confirmar', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' })
    const { condominio_id } = req.body
    const resultado = await importarPlanilha(req.file.buffer, condominio_id)
    res.json(resultado)
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// GET /admin/admins — lista admins whatsapp
app.get('/admin/admins', async (req, res) => {
  try {
    const admins = await db.listarAdmins()
    res.json({ admins })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// POST /admin/admins — adiciona admin
app.post('/admin/admins', async (req, res) => {
  try {
    const { celular, nome } = req.body
    await db.adicionarAdmin(celular, nome)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// DELETE /admin/admins/:celular — remove admin
app.delete('/admin/admins/:celular', async (req, res) => {
  try {
    await db.removerAdmin(req.params.celular)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// GET /admin/stats — estatísticas do dashboard
app.get('/admin/stats', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js')
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    const [total, pendentes, aprovados, logs] = await Promise.all([
      supa.from('moradores').select('*', { count: 'exact', head: true }),
      supa.from('moradores').select('*', { count: 'exact', head: true }).eq('status', 'pendente'),
      supa.from('moradores').select('*', { count: 'exact', head: true }).eq('status', 'aprovado'),
      supa.from('logs_acesso').select('*', { count: 'exact', head: true }).gte('criado_em', new Date(Date.now() - 86400000).toISOString()),
    ])
    res.json({
      total: total.count || 0,
      pendentes: pendentes.count || 0,
      aprovados: aprovados.count || 0,
      acessos_hoje: logs.count || 0,
    })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// GET /admin/logs
app.get('/admin/logs', async (req, res) => {
  try {
    const { tipo, resultado, limit = 50 } = req.query
    const { createClient } = require('@supabase/supabase-js')
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    let q = supa.from('logs_acesso')
      .select('*, moradores(nome), geladeiras(nome)')
      .order('criado_em', { ascending: false })
      .limit(parseInt(limit))
    if (tipo) q = q.eq('tipo', tipo)
    if (resultado) q = q.eq('resultado', resultado)
    const { data, error } = await q
    if (error) throw error
    res.json({ logs: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// GET /admin/geladeiras
app.get('/admin/geladeiras', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js')
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    const { data, error } = await supa.from('geladeiras').select('*, condominios(nome)').order('nome')
    if (error) throw error
    res.json({ geladeiras: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// GET /admin/condominios
app.get('/admin/condominios', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js')
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    const { data, error } = await supa.from('condominios').select('*').order('nome')
    if (error) throw error
    res.json({ condominios: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// PATCH /admin/condominios/:id
app.patch('/admin/condominios/:id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js')
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    const { data, error } = await supa.from('condominios').update(req.body).eq('id', req.params.id).select().single()
    if (error) throw error
    res.json({ condominio: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// GET /painel — serve o painel admin
app.get('/painel', (req, res) => {
  res.sendFile(__dirname + '/painel.html')
})
// ESP32 heartbeat — atualiza IP automaticamente no banco
app.post('/esp32/heartbeat', async (req, res) => {
  res.sendStatus(200)
  try {
    const secret = req.headers['x-esp32-secret']
    if (secret !== (process.env.ESP32_SECRET || 'troque-por-uma-chave-secreta-forte')) return
    const { geladeira, ip, evento } = req.body
    if (!geladeira || !ip) return
    const sb = require('./db')
    // atualiza IP direto no banco via supabase
    const { createClient } = require('@supabase/supabase-js')
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    await supa.from('geladeiras').update({ esp32_ip: ip }).ilike('nome', '%' + geladeira + '%')
    console.log('ESP32 heartbeat:', geladeira, 'IP:', ip, evento)
  } catch (err) {
    console.error('Erro heartbeat ESP32:', err)
  }
})

// ─── HELPERS ──────────────────────────────────────────────────────
function detectarTipo(msg) {
  if (msg.imageMessage) return 'image'
  if (msg.documentMessage) return 'document'
  if (msg.audioMessage) return 'audio'
  if (msg.videoMessage) return 'video'
  return 'text'
}

function extrairTexto(msg, tipo) {
  if (tipo === 'text') {
    return msg.conversation || msg.extendedTextMessage?.text || ''
  }
  // Para imagens, pode vir legenda
  if (tipo === 'image') return msg.imageMessage?.caption || ''
  return ''
}

// ─── START ────────────────────────────────────────────────────────
app.listen(config.PORT, () => {
  console.log(`✅ SelfStore Bot rodando na porta ${config.PORT}`)
})
