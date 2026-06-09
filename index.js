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
const { cadastrarRostoIDFace, urlParaBase64 } = require('./idface')

// Busca imagem completa via Evolution API (evita thumbnail de baixa resolução)
async function buscarImagemCompleta(messageId) {
  try {
    const res = await fetch(
      `${process.env.EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${process.env.EVOLUTION_INSTANCE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.EVOLUTION_API_KEY,
        },
        body: JSON.stringify({
          message: { key: { id: messageId } },
          convertToMp4: false,
        }),
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.base64 || null
  } catch(e) {
    console.error('Erro ao buscar imagem completa:', e.message)
    return null
  }
}

// Helper Supabase com ws (evita erro de WebSocket no Node 20)
const ws = require('ws')
const { createClient: _createClient } = require('@supabase/supabase-js')
function getSupa() {
  return _createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    realtime: { transport: ws }
  })
}

const app = express()
app.use(express.json({ limit: '20mb' }))
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type,X-ESP32-Secret')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
}) // imagens chegam em base64

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
    // Extrai imagem em resolução completa via Evolution API
    // O jpegThumbnail é uma miniatura — precisamos buscar a imagem original
    let imagemBase64 = null
    let messageId = null
    if (tipoMensagem === 'image') {
      messageId = evento.data?.key?.id || null
      if (messageId) {
        // Busca imagem completa (mínimo 160x160 exigido pelo iDFace)
        imagemBase64 = await buscarImagemCompleta(messageId)
      }
      // Fallback: tenta o thumbnail se não conseguiu a imagem completa
      if (!imagemBase64) {
        const thumb = msg.imageMessage?.jpegThumbnail
        if (thumb) {
          if (typeof thumb === 'string') imagemBase64 = thumb
          else if (thumb instanceof Uint8Array || Buffer.isBuffer(thumb)) {
            imagemBase64 = Buffer.from(thumb).toString('base64')
          } else if (typeof thumb === 'object') {
            try { imagemBase64 = Buffer.from(Object.values(thumb)).toString('base64') } catch(e) {}
          }
        }
      }
    }

    // ── ROTEAMENTO ──────────────────────────────────────────────

    // Verifica se é admin com sessão ativa ou digitou ADMIN
    const adminAutorizado = await isAdmin(celular)
    if (adminAutorizado) {
      const sessaoAdmin = await db.buscarSessao('admin_' + celular)
      const { isComandoAdmin } = require('./admin-whatsapp')
      if (sessaoAdmin || isComandoAdmin(textoMensagem)) {
        const resultado = await handleAdmin(celular, textoMensagem, tipoMensagem, imagemBase64)
        if (resultado !== 'continuar') return
      }
    }

    // ── PRIORIDADE 1: sessão de cadastro ativa — continua sempre ──
    // Deve ser verificada ANTES de qualquer outro roteamento
    // para evitar que respostas numéricas (1, 2, etc.) sejam
    // interceptadas por outros handlers durante o fluxo de cadastro
    const sessaoAtiva = await db.buscarSessao(celular)
    if (sessaoAtiva || tipoMensagem === 'image') {
      await handleCadastro(celular, textoMensagem, tipoMensagem, imagemBase64)
      return
    }

    // ── PRIORIDADE 2: comando de abertura de geladeira (QR Code) ──
    if (tipoMensagem === 'text' && isComandoGeladeira(textoMensagem)) {
      await handleGeladeira(celular, textoMensagem)
      return
    }

    // ── PRIORIDADE 3: palavras-chave para iniciar cadastro ──
    const textUpper = textoMensagem.toUpperCase().trim()
    const isCadastro = ['2', 'CADASTRO', 'CADASTRAR', 'OI', 'OLÁ', 'OLA', 'INICIO', 'INÍCIO', 'START']
      .includes(textUpper)

    if (isCadastro) {
      await handleCadastro(celular, textoMensagem, tipoMensagem, imagemBase64)
      return
    }

    // ── PRIORIDADE 4: opção 1 do menu — instrução do QR Code ──
    if (textUpper === '1') {
      await enviarTexto(
        celular,
        `📷 Para abrir a geladeira, aponte a câmera do seu celular para o *QR Code* colado na geladeira.\n\nÉ rápido e simples! 😊`
      )
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
    const supa = getSupa()
    let query = supa.from('moradores').select('*, condominios(nome)', { count: 'exact' })
    if (status && status !== 'todos') query = query.eq('status', status)
    if (busca) query = query.or(`nome.ilike.%${busca}%,cpf.ilike.%${busca}%,unidade.ilike.%${busca}%`)
    query = query.order('criado_em', { ascending: false }).range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)
    const { data, error, count } = await query
    if (error) throw error
    res.json({ moradores: data, total: count })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// PATCH /admin/moradores/:id — atualiza status e notifica morador
app.patch('/admin/moradores/:id', async (req, res) => {
  try {
    const { status } = req.body
    const morador = await db.atualizarStatusMorador(req.params.id, status)
    res.json({ morador })

    // Notifica o morador via WhatsApp após aprovação ou rejeição
    if (morador && morador.celular_whatsapp) {
      // enviarTexto, cadastrarRostoIDFace, urlParaBase64 já importados no topo

      if (status === 'aprovado') {
        await enviarTexto(morador.celular_whatsapp, MSG.cadastroAprovadoAuto(morador.nome))

        // Sincroniza rosto com iDFace se tiver foto
        if (morador.foto_url) {
          try {
            const { createClient } = require('@supabase/supabase-js')
            const ws = require('ws')
            const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: ws } })
            const { data: cond } = await supa.from('condominios').select('*').eq('id', morador.condominio_id).single()
            if (cond?.idface_ip) {
              const fotoBase64 = await urlParaBase64(morador.foto_url)
              await cadastrarRostoIDFace(cond.idface_ip, cond.idface_senha, morador, fotoBase64, cond.idface_user || 'admin')
              console.log(`Rosto sincronizado com iDFace: ${morador.nome}`)
            }
          } catch(e) {
            console.error('Erro ao sincronizar iDFace:', e.message)
          }
        }
      } else if (status === 'rejeitado') {
        await enviarTexto(morador.celular_whatsapp, MSG.acessoNegadoRejeitado())
      }
    }
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
    const supa = getSupa()
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
    const supa = getSupa()
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
    const supa = getSupa()
    const { data, error } = await supa.from('geladeiras').select('*, condominios(nome)').order('nome')
    if (error) throw error
    res.json({ geladeiras: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// GET /admin/condominios
app.get('/admin/condominios', async (req, res) => {
  try {
    const supa = getSupa()
    const { data, error } = await supa.from('condominios').select('*').order('nome')
    if (error) throw error
    res.json({ condominios: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// PATCH /admin/condominios/:id
app.patch('/admin/condominios/:id', async (req, res) => {
  try {
    const supa = getSupa()
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
    const supa = getSupa()
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
