// index.js — servidor principal

const express = require('express')
const config = require('./config')
const { handleCadastro } = require('./cadastro')
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
