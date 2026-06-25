// index.js — servidor principal

const express = require('express')
const config = require('./config')
const { handleCadastro, sincronizarComIDFace } = require('./cadastro')
const { handleAdmin, isAdmin } = require('./admin-whatsapp')
const { previewPlanilha, importarPlanilha, cadastrarManual } = require('./importacao')
const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const { handleGeladeira, isComandoGeladeira } = require('./geladeira')
const { enviarTexto, buscarImagemMeta, MSG } = require('./whatsapp')
const db = require('./db')


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

// ─── WEBHOOK — Meta Cloud API ─────────────────────────────────────

// GET — verificação do webhook pela Meta
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === config.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook Meta verificado com sucesso')
    return res.status(200).send(challenge)
  }
  res.sendStatus(403)
})

// POST — recebe mensagens do WhatsApp via Meta Cloud API
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200)
  try {
    const body = req.body
    if (body.object !== 'whatsapp_business_account') return

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue
        const value = change.value
        const messages = value?.messages
        if (!messages?.length) continue

        for (const msg of messages) {
          await processarMensagemMeta(msg, value)
        }
      }
    }
  } catch (err) {
    console.error('Erro no webhook Meta:', err)
  }
})

async function processarMensagemMeta(msg, value) {
  try {
    const celular = msg.from
    if (!celular) return

    const tipoMensagem = detectarTipo(msg)
    const textoMensagem = extrairTexto(msg, tipoMensagem)

    let imagemBase64 = null
    if (tipoMensagem === 'image') {
      const mediaId = msg.image?.id
      if (mediaId) imagemBase64 = await buscarImagemMeta(mediaId)
    }

    // ── ROTEAMENTO ──────────────────────────────────────────────

    const adminAutorizado = await isAdmin(celular)
    if (adminAutorizado) {
      const sessaoAdmin = await db.buscarSessao('admin_' + celular)
      const { isComandoAdmin } = require('./admin-whatsapp')
      if (sessaoAdmin || isComandoAdmin(textoMensagem)) {
        const resultado = await handleAdmin(celular, textoMensagem, tipoMensagem, imagemBase64)
        if (resultado !== 'continuar') return
      }
    }

    const sessaoAtiva = await db.buscarSessao(celular)
    if (sessaoAtiva || tipoMensagem === 'image') {
      await handleCadastro(celular, textoMensagem, tipoMensagem, imagemBase64)
      return
    }

    if (tipoMensagem === 'text' && isComandoGeladeira(textoMensagem)) {
      await handleGeladeira(celular, textoMensagem)
      return
    }

    const textUpper = textoMensagem.toUpperCase().trim()
    const isCadastro = ['2', 'CADASTRO', 'CADASTRAR', 'OI', 'OLÁ', 'OLA', 'INICIO', 'INÍCIO', 'START']
      .includes(textUpper)

    if (isCadastro) {
      await handleCadastro(celular, textoMensagem, tipoMensagem, imagemBase64)
      return
    }

    if (textUpper === '1') {
      await enviarTexto(celular, `📷 Para abrir a geladeira, aponte a câmera do seu celular para o *QR Code* colado na geladeira.\n\nÉ rápido e simples! 😊`)
      return
    }

    await enviarTexto(celular, MSG.naoEntendido())
  } catch (err) {
    console.error('Erro ao processar mensagem Meta:', err)
  }
}

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
        try { await enviarTexto(morador.celular_whatsapp, MSG.cadastroAprovadoAuto(morador.nome)) } catch(e) { console.error('Erro ao notificar morador WhatsApp:', e.message) }

        // Sincroniza rosto com iDFace se tiver foto
        if (morador.foto_url) {
          try {
            const { createClient } = require('@supabase/supabase-js')
            const ws = require('ws')
            const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: ws } })
            const { data: cond } = await supa.from('condominios').select('*').eq('id', morador.condominio_id).single()
            if (cond?.idface_ip) {
              const { cadastrarRostoIDFace, urlParaBase64 } = require('./idface')
              const fotoBase64 = await urlParaBase64(morador.foto_url)
              await cadastrarRostoIDFace(cond.idface_ip, cond.idface_senha, morador, fotoBase64, cond.idface_user || 'admin')
              console.log(`Rosto sincronizado com iDFace: ${morador.nome}`)
            }
          } catch(e) {
            console.error('Erro ao sincronizar iDFace:', e.message)
          }
        }
      } else if (status === 'rejeitado') {
        try { await enviarTexto(morador.celular_whatsapp, MSG.acessoNegadoRejeitado()) } catch(e) { console.error('Erro ao notificar rejeicao WhatsApp:', e.message) }
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
    const supa = getSupa()
    await supa.from('geladeiras').update({ esp32_ip: ip }).ilike('nome', '%' + geladeira + '%')
    console.log('ESP32 heartbeat:', geladeira, 'IP:', ip, evento)
  } catch (err) {
    console.error('Erro heartbeat ESP32:', err)
  }
})

// ─── HELPERS ──────────────────────────────────────────────────────
function detectarTipo(msg) {
  const tipo = msg.type
  if (tipo === 'image') return 'image'
  if (tipo === 'document') return 'document'
  if (tipo === 'audio') return 'audio'
  if (tipo === 'video') return 'video'
  return 'text'
}

function extrairTexto(msg, tipo) {
  if (tipo === 'text') return msg.text?.body || ''
  if (tipo === 'image') return msg.image?.caption || ''
  return ''
}

// ─── START ────────────────────────────────────────────────────────
app.listen(config.PORT, () => {
  console.log(`✅ SelfStore Bot rodando na porta ${config.PORT}`)
})
