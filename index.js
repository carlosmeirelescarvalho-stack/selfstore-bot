// index.js — servidor principal v2

const express = require('express')
const cron = require('node-cron')
const config = require('./config')
const { handleCadastro, iniciarCadastro } = require('./cadastro')
const { handleAdmin, isAdmin, isComandoAdmin } = require('./admin-whatsapp')
const { previewPlanilha, importarPlanilha, cadastrarManual } = require('./importacao')
const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const { handleGeladeira, isComandoGeladeira, handleGeladeiraTC } = require('./geladeira')
const { handleExclusao, iniciarExclusao } = require('./exclusao')
const { enviarTexto, enviarBotoes, buscarImagemMeta, iniciarAtendimentoHumano, notificarAdmin, MSG } = require('./whatsapp')
const db = require('./db')

const getDb = () => db.supabase()

const app = express()
app.use(express.json({ limit: '20mb' }))
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type,X-ESP32-Secret,Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// ─── AUTH MIDDLEWARE — protege /admin/* ───────────────────────────
function autenticarAdmin(req, res, next) {
  if (!config.ADMIN_API_KEY) {
    return res.status(500).json({ erro: 'ADMIN_API_KEY não configurada no servidor.' })
  }
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== config.ADMIN_API_KEY) {
    return res.status(401).json({ erro: 'Não autorizado. API key inválida ou ausente.' })
  }
  next()
}
app.use('/admin', autenticarAdmin)

// ─── CRON — limpeza de sessões abandonadas (8h São Paulo) ─────────
cron.schedule('0 8 * * *', async () => {
  try {
    const abandonadas = await db.buscarSessoesAbandonadas()
    for (const s of abandonadas) {
      try {
        await enviarTexto(s.celular, MSG.sessaoAbandonada())
      } catch(e) { /* celular pode ser admin_xxx, ignora */ }
      await db.deletarSessao(s.celular)
    }
    console.log(`Cron 8h: ${abandonadas.length} sessões abandonadas limpas`)
  } catch(e) {
    console.error('Erro cron sessoes abandonadas:', e)
  }
}, { timezone: 'America/Sao_Paulo' })

// ─── DEBOUNCE — alertas bloqueio (30 min por morador) ────────────
const _alertasBloqueio = new Map()
const DEBOUNCE_BLOQUEIO_MS = 30 * 60 * 1000

function podeAlertarBloqueio(moradorId) {
  const agora = Date.now()
  const ultimo = _alertasBloqueio.get(moradorId)
  if (ultimo && (agora - ultimo) < DEBOUNCE_BLOQUEIO_MS) return false
  _alertasBloqueio.set(moradorId, agora)
  return true
}

// ─── CRON — monitoramento Pi offline (a cada 15 min) ─────────────
const _alertasRecentes = new Map()

cron.schedule('*/15 * * * *', async () => {
  try {
    const { data: geladeiras } = await getDb()
      .from('geladeiras')
      .select('id, nome, esp32_ip, ultimo_heartbeat, condominio_id, condominios(nome)')
      .not('esp32_ip', 'is', null)

    if (!geladeiras?.length) return

    const agora = Date.now()
    const LIMITE_MS = 2 * 60 * 1000
    const DEBOUNCE_MS = 30 * 60 * 1000

    for (const g of geladeiras) {
      if (!g.ultimo_heartbeat) continue
      const diff = agora - new Date(g.ultimo_heartbeat).getTime()
      if (diff <= LIMITE_MS) continue

      const ultimoAlerta = _alertasRecentes.get(g.id)
      if (ultimoAlerta && (agora - ultimoAlerta) < DEBOUNCE_MS) continue

      _alertasRecentes.set(g.id, agora)
      const minOffline = Math.round(diff / 60000)
      await notificarAdmin(
        `🔴 *Pi offline*\n\n` +
        `Geladeira: ${g.nome}\n` +
        `Condomínio: ${g.condominios?.nome || 'N/A'}\n` +
        `Último heartbeat: ${minOffline} min atrás\n\n` +
        `O dispositivo pode estar sem energia ou sem Wi-Fi.`,
        g.condominio_id
      )
      console.log(`Alerta Pi offline: ${g.nome} (${minOffline} min)`)
    }
  } catch (e) {
    console.error('Erro cron monitoramento Pi:', e)
  }
})

// ─── WEBHOOK — Meta Cloud API ─────────────────────────────────────

app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === config.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook Meta verificado')
    return res.status(200).send(challenge)
  }
  res.sendStatus(403)
})

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200)
  try {
    const body = req.body
    if (body.object !== 'whatsapp_business_account') return

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue
        const messages = change.value?.messages
        if (!messages?.length) continue
        for (const msg of messages) {
          await processarMensagemMeta(msg, change.value)
        }
      }
    }
  } catch (err) {
    console.error('Erro webhook Meta:', err)
  }
})

async function processarMensagemMeta(msg, value) {
  try {
    const celular = msg.from
    if (!celular) return

    const tipoMensagem = detectarTipo(msg)
    const textoMensagem = extrairTexto(msg, tipoMensagem)
    const buttonId = extrairButtonId(msg)

    const conteudoLog = buttonId ? `[button:${buttonId}] ${textoMensagem}` : textoMensagem
    db.registrarMensagem(celular, 'recebida', conteudoLog || `[${tipoMensagem}]`, tipoMensagem)

    let imagemBase64 = null
    if (tipoMensagem === 'image') {
      const mediaId = msg.image?.id
      if (mediaId) imagemBase64 = await buscarImagemMeta(mediaId)
    }

    // ── AJUDA global (antes de qualquer roteamento) ──
    if (textoMensagem.toUpperCase().trim() === 'AJUDA') {
      const moradorAjuda = await db.buscarMoradorPorCelular(celular)
      if (moradorAjuda) {
        await enviarBotoes(celular, MSG.menuAjuda(), [
          { id: 'ajuda_atendimento', titulo: 'Falar com suporte' },
          { id: 'ajuda_excluir_dados', titulo: 'Excluir meus dados' },
        ])
      } else {
        await iniciarAtendimentoHumano(celular)
      }
      return
    }

    // ── Admin: só consulta banco se há sessão admin ativa ou comando ADMIN ──
    const sessaoAdmin = await db.buscarSessao('admin_' + celular)
    if (sessaoAdmin || isComandoAdmin(textoMensagem)) {
      const adminAutorizado = await isAdmin(celular)
      if (adminAutorizado) {
        const resultado = await handleAdmin(celular, textoMensagem, tipoMensagem, imagemBase64, buttonId)
        if (resultado !== 'continuar') return
      } else if (isComandoAdmin(textoMensagem)) {
        await enviarTexto(celular, '⛔ Você não tem permissão de administrador.')
        return
      }
    }

    // ── Sessão ativa (cadastro, geladeira_tc, morador_tc, atendimento) ──
    const sessaoAtiva = await db.buscarSessao(celular)
    if (sessaoAtiva) {
      const etapa = sessaoAtiva.etapa_atual

      // T&C geladeira
      if (etapa === 'geladeira_tc') {
        const handled = await handleGeladeiraTC(celular, buttonId)
        if (handled) return
      }

      // T&C morador (cadastrado pelo admin)
      if (etapa === 'morador_tc') {
        await handleMoradorTC(celular, buttonId, sessaoAtiva)
        return
      }

      // Aguardando cadastro vindo da geladeira
      if (etapa === 'aguardando_cadastro_geladeira') {
        if (buttonId === 'iniciar_cadastro') {
          const dados = sessaoAtiva.dados_parciais || {}
          await db.deletarSessao(celular)
          await iniciarCadastro(celular, dados.condominio_origem)
          return
        }
      }

      // Sub-fluxo exclusão de dados (LGPD)
      if (etapa === 'exclusao_confirmar') {
        const handled = await handleExclusao(celular, buttonId)
        if (handled) return
      }

      // Sub-fluxo atendimento humano
      if (etapa === 'atendimento_nome') {
        await handleAtendimentoNome(celular, textoMensagem)
        return
      }
      if (etapa === 'atendimento_motivo') {
        await handleAtendimentoMotivo(celular, textoMensagem)
        return
      }

      // Cadastro normal
      await handleCadastro(celular, textoMensagem, tipoMensagem, imagemBase64, buttonId)
      return
    }

    // ── Comando de abertura de geladeira ──
    if (tipoMensagem === 'text' && isComandoGeladeira(textoMensagem)) {
      await handleGeladeira(celular, textoMensagem, buttonId)
      return
    }

    // ── QR Code de cadastro por condomínio (ex: "CADASTRO @Adele Zarzur") ──
    if (tipoMensagem === 'text' && textoMensagem.trim().toUpperCase().startsWith('CADASTRO')) {
      const moradorExistente = await db.buscarMoradorPorCelular(celular)
      if (moradorExistente) {
        await handleFluxo0(celular, textoMensagem, null)
        return
      }
      const matchCond = textoMensagem.match(/@(.+)/i)
      const nomeCond = matchCond ? matchCond[1].trim() : null
      await iniciarCadastro(celular, nomeCond)
      return
    }

    // ── FLUXO 0 — primeira interação / roteamento ──
    await handleFluxo0(celular, textoMensagem, buttonId)

  } catch (err) {
    console.error('Erro ao processar mensagem:', err)
  }
}

// ─── FLUXO 0 — Welcome & Routing ─────────────────────────────────

async function handleFluxo0(celular, texto, buttonId) {
  console.log('Fluxo0:', { celular, texto, buttonId })

  if (buttonId === 'iniciar_cadastro') {
    await iniciarCadastro(celular)
    return
  }

  if (buttonId === 'fluxo0_ajuda' || buttonId === 'ajuda_atendimento') {
    await iniciarAtendimentoHumano(celular)
    return
  }

  if (buttonId === 'ajuda_excluir_dados') {
    await iniciarExclusao(celular)
    return
  }

  const morador = await db.buscarMoradorPorCelular(celular)

  if (morador && morador.status === 'aprovado') {
    await enviarBotoes(celular, MSG.jaCadastrado(), [
      { id: 'fluxo0_ajuda', titulo: 'Atendimento humano' },
    ])
  } else if (morador && morador.status === 'pendente') {
    await enviarTexto(celular, MSG.acessoNegadoPendente())
  } else if (morador && morador.status === 'bloqueado') {
    await enviarBotoes(celular, MSG.acessoBloqueado(), [
      { id: 'fluxo0_ajuda', titulo: 'Falar com suporte' },
    ])
    if (podeAlertarBloqueio(morador.id)) {
      const hora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      await notificarAdmin(
        `⚠️ *Tentativa de acesso — morador bloqueado*\n\n` +
        `Morador: ${morador.nome}\n` +
        `Celular: ${celular}\n` +
        `Via: WhatsApp (mensagem direta)\n` +
        `Horário: ${hora}`,
        morador.condominio_id
      )
    }
  } else {
    await enviarBotoes(celular, `${MSG.apresentacao()}\n\n${MSG.naoCadastrado()}`, [
      { id: 'iniciar_cadastro', titulo: 'Fazer cadastro' },
      { id: 'fluxo0_ajuda', titulo: 'Falar com atendente' },
    ])
  }
}

// ─── Handler T&C morador (cadastrado pelo admin) ──────────────────

async function handleMoradorTC(celular, buttonId, sessao) {
  const dados = sessao.dados_parciais || {}

  if (buttonId === 'tc_morador_aceito') {
    await db.atualizarAceiteTCMorador(dados.morador_id)
    await enviarTexto(celular, MSG.moradorTCAceito())
    await db.deletarSessao(celular)
    return
  }

  if (buttonId === 'tc_morador_recusado') {
    await enviarTexto(celular, MSG.geladeiraAceiteTCRecusado())
    await db.deletarSessao(celular)
    return
  }

  await enviarBotoes(celular, MSG.naoEntendidoFluxo0(), [
    { id: 'tc_morador_aceito', titulo: 'Li e estou de acordo' },
    { id: 'tc_morador_recusado', titulo: 'Não estou de acordo' },
  ])
}

// ─── Sub-fluxo atendimento humano ─────────────────────────────────

async function handleAtendimentoNome(celular, texto) {
  const dados = { nome_atendimento: texto.trim() }
  await db.salvarSessao(celular, 'atendimento_motivo', dados)
  await enviarTexto(celular, 'Obrigado! E qual o *motivo* do contato?')
}

async function handleAtendimentoMotivo(celular, texto) {
  const sessao = await db.buscarSessao(celular)
  const dados = sessao?.dados_parciais || {}
  await db.deletarSessao(celular)

  const hora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  let transcriptBloco = ''
  try {
    const msgs = await db.buscarMensagensPorCelular(celular, 15)
    if (msgs.length) {
      const linhas = msgs.map(m => {
        const dt = new Date(m.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
        const icon = m.direcao === 'recebida' ? '👤' : '🤖'
        const conteudo = (m.conteudo || '').substring(0, 200)
        return `[${dt}] ${icon} ${conteudo}`
      })
      transcriptBloco = `\n\n📋 *Histórico recente:*\n${linhas.join('\n')}`
      if (transcriptBloco.length > 3000) {
        transcriptBloco = transcriptBloco.substring(0, 3000) + '\n…(truncado)'
      }
    }
  } catch (e) { console.error('Erro ao buscar transcript:', e.message) }

  await notificarAdmin(
    `📲 *Solicitação de atendimento*\n\n` +
    `Nome: ${dados.nome_atendimento || 'N/A'}\n` +
    `Celular: ${celular}\n` +
    `Motivo: ${texto}\n` +
    `Horário: ${hora}` +
    transcriptBloco
  )
  await enviarTexto(celular, '✅ Seus dados foram encaminhados para nosso time de suporte. Em breve entrarão em contato!')
}

// ─── WEBHOOK iDFace ───────────────────────────────────────────────
app.post('/webhook/idface', async (req, res) => {
  res.sendStatus(200)
  try {
    const evento = req.body
    if (!evento.user_id) return
    const negado = evento.result !== 'granted'
    const morador = await db.buscarMoradorPorCpfNumerico(evento.user_id)
    await db.registrarLog(morador?.id || null, null, 'facial',
      negado ? 'negado' : 'aberto',
      negado ? evento.result : `cpf:${evento.user_id}`)

    if (!negado && morador) {
      db.atualizarUltimoAcesso(morador.id)
    }
    if (negado && morador?.status === 'bloqueado' && podeAlertarBloqueio(morador.id)) {
      const hora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      await notificarAdmin(
        `⚠️ *Tentativa de acesso — morador bloqueado*\n\n` +
        `Morador: ${morador.nome}\n` +
        `Via: Reconhecimento facial (iDFace)\n` +
        `Horário: ${hora}`,
        morador.condominio_id
      )
    }
  } catch (err) {
    console.error('Erro webhook iDFace:', err)
  }
})

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }))

// ─── ENDPOINTS PAINEL ADMIN ───────────────────────────────────────

app.get('/admin/moradores', async (req, res) => {
  try {
    const { status, busca, limit = 50, offset = 0 } = req.query
    const supa = getDb()
    let query = supa.from('moradores').select('*, condominios(nome)', { count: 'exact' })
    if (status && status !== 'todos') query = query.eq('status', status)
    if (busca) query = query.or(`nome.ilike.%${busca}%,cpf.ilike.%${busca}%,unidade.ilike.%${busca}%`)
    query = query.order('criado_em', { ascending: false }).range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)
    const { data, error, count } = await query
    if (error) throw error
    res.json({ moradores: data, total: count })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.patch('/admin/moradores/:id', async (req, res) => {
  try {
    const { status } = req.body
    const morador = await db.atualizarStatusMorador(req.params.id, status)
    res.json({ morador })

    if (morador && morador.celular_whatsapp) {
      if (status === 'aprovado') {
        let syncOk = false
        const supa = getDb()
        const { data: cond } = await supa.from('condominios').select('*').eq('id', morador.condominio_id).single()
        if (morador.foto_url && cond?.idface_ip) {
          try {
            const { cadastrarRostoIDFace, urlParaBase64 } = require('./idface')
            const fotoBase64 = await urlParaBase64(morador.foto_url)
            await cadastrarRostoIDFace(cond.idface_ip, cond.idface_senha, morador, fotoBase64, cond.idface_user || 'admin')
            syncOk = true
          } catch(e) { console.error('Erro iDFace sync:', e.message) }
        }
        try {
          if (syncOk || !cond?.idface_ip) {
            await enviarTexto(morador.celular_whatsapp, MSG.cadastroAprovadoAuto(morador.nome))
          } else {
            await enviarBotoes(morador.celular_whatsapp, MSG.cadastroAprovadoSemFace(morador.nome), [
              { id: 'fluxo0_ajuda', titulo: 'Falar com suporte' },
            ])
          }
        } catch(e) { console.error('Erro notif WhatsApp:', e.message) }
      } else if (status === 'rejeitado') {
        try { await enviarTexto(morador.celular_whatsapp, MSG.acessoNegadoRejeitado()) } catch(e) { console.error('Erro notif rejeicao:', e.message) }
      } else if (status === 'bloqueado') {
        try {
          await enviarBotoes(morador.celular_whatsapp, MSG.acessoBloqueado(), [
            { id: 'fluxo0_ajuda', titulo: 'Falar com suporte' },
          ])
        } catch(e) { console.error('Erro notif bloqueio:', e.message) }
      }
    }
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.put('/admin/moradores/:id', async (req, res) => {
  try {
    const morador = await db.atualizarMorador(req.params.id, req.body)
    res.json({ morador })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.delete('/admin/moradores/:id', async (req, res) => {
  try {
    const supa = getDb()
    const { data: morador } = await supa.from('moradores').select('*, condominios(*)').eq('id', req.params.id).single()
    if (morador?.cpf && morador?.condominios?.idface_ip && morador?.condominios?.idface_senha) {
      try {
        const { removerUsuarioIDFace } = require('./idface')
        await removerUsuarioIDFace(
          morador.condominios.idface_ip,
          morador.condominios.idface_senha,
          morador.cpf,
          morador.condominios.idface_user || 'admin'
        )
      } catch(e) { console.error('Erro ao remover do iDFace:', e.message) }
    }
    await db.deletarMorador(req.params.id)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/moradores/:id/reenviar-tc', async (req, res) => {
  try {
    const supa = getDb()
    const { data: m, error } = await supa.from('moradores').select('*, condominios(nome)').eq('id', req.params.id).single()
    if (error) throw error
    if (m.aceite_tc) return res.status(400).json({ erro: 'Morador já aceitou os T&C' })
    await enviarBotoes(m.celular_whatsapp,
      MSG.moradorTCNotificacao(m.nome, m.condominios?.nome || '', config.LINK_TC),
      [
        { id: 'tc_morador_aceito', titulo: 'Li e estou de acordo' },
        { id: 'tc_morador_recusado', titulo: 'Não concordo' },
      ]
    )
    await db.salvarSessao(m.celular_whatsapp, 'morador_tc', {})
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/moradores/reenviar-tc-batch', async (req, res) => {
  try {
    const supa = getDb()
    const { data: pendentes, error } = await supa.from('moradores').select('*, condominios(nome)').eq('aceite_tc', false)
    if (error) throw error
    let enviados = 0, falhas = 0
    for (const m of pendentes || []) {
      try {
        await enviarBotoes(m.celular_whatsapp,
          MSG.moradorTCNotificacao(m.nome, m.condominios?.nome || '', config.LINK_TC),
          [
            { id: 'tc_morador_aceito', titulo: 'Li e estou de acordo' },
            { id: 'tc_morador_recusado', titulo: 'Não concordo' },
          ]
        )
        await db.salvarSessao(m.celular_whatsapp, 'morador_tc', {})
        enviados++
      } catch (e) {
        console.error(`Erro reenvio TC ${m.celular_whatsapp}:`, e.message)
        falhas++
      }
    }
    res.json({ enviados, falhas, total: (pendentes||[]).length })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/moradores', async (req, res) => {
  try {
    const resultado = await cadastrarManual(req.body)
    if (resultado.erro) return res.status(400).json({ erro: resultado.erro })
    res.json(resultado)
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/moradores/:id/foto', upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' })
    const supa = getDb()
    const { data: morador, error } = await supa.from('moradores').select('*, condominios(nome, idface_ip, idface_senha, idface_user)').eq('id', req.params.id).single()
    if (error) throw error
    const fotoUrl = await db.uploadFoto(morador.celular_whatsapp, req.file.buffer, req.file.mimetype)
    await db.atualizarFotoMorador(morador.id, fotoUrl)
    let syncOk = false
    if (morador.status === 'aprovado' && morador.condominios?.idface_ip) {
      try {
        const { cadastrarRostoIDFace, urlParaBase64 } = require('./idface')
        const fotoBase64 = await urlParaBase64(fotoUrl)
        await cadastrarRostoIDFace(morador.condominios.idface_ip, morador.condominios.idface_senha, morador, fotoBase64, morador.condominios.idface_user || 'admin')
        syncOk = true
      } catch (e) { console.error('Erro sync iDFace foto:', e.message) }
    }
    res.json({ foto_url: fotoUrl, idface_sync: syncOk })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/importar/preview', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' })
    const { condominio_id } = req.body
    const preview = await previewPlanilha(req.file.buffer, condominio_id)
    res.json(preview)
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/importar/confirmar', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' })
    const { condominio_id } = req.body
    const resultado = await importarPlanilha(req.file.buffer, condominio_id)
    res.json(resultado)
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/admin/admins', async (req, res) => {
  try {
    const admins = await db.listarAdmins()
    res.json({ admins })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/admins', async (req, res) => {
  try {
    const { celular, nome, cpf, condominio_ids } = req.body
    const admin = await db.adicionarAdmin(celular, nome, cpf, condominio_ids)
    res.json({ admin })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.patch('/admin/admins/:id', async (req, res) => {
  try {
    const { nome, cpf, celular, condominio_ids } = req.body
    const campos = {}
    if (nome !== undefined) campos.nome = nome
    if (cpf !== undefined) campos.cpf = cpf
    if (celular !== undefined) campos.celular = celular
    await db.atualizarAdmin(req.params.id, campos, condominio_ids)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.delete('/admin/admins/:id', async (req, res) => {
  try {
    await db.removerAdmin(req.params.id)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/admin/stats', async (req, res) => {
  try {
    const supa = getDb()
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

app.get('/admin/dashboard/acessos', async (req, res) => {
  try {
    const supa = getDb()
    const now = new Date()
    const inicio = new Date(now); inicio.setHours(0,0,0,0)
    const fim = new Date(now); fim.setHours(23,59,59,999)

    const { data: logs, error } = await supa.from('logs_acesso')
      .select('*')
      .gte('criado_em', inicio.toISOString())
      .lte('criado_em', fim.toISOString())
      .order('criado_em', { ascending: false })
      .limit(200)
    if (error) throw error

    const moradorIds = [...new Set((logs || []).map(l => l.morador_id).filter(Boolean))]
    const geladeiraIds = [...new Set((logs || []).map(l => l.geladeira_id).filter(Boolean))]
    const moradorMap = {}, geladeiraMap = {}, condMap = {}

    if (moradorIds.length) {
      const { data: mors } = await supa.from('moradores')
        .select('id, nome, foto_url, bloco, unidade, condominio_id')
        .in('id', moradorIds)
      for (const m of (mors || [])) moradorMap[m.id] = m
    }
    if (geladeiraIds.length) {
      const { data: gels } = await supa.from('geladeiras').select('id, nome').in('id', geladeiraIds)
      for (const g of (gels || [])) geladeiraMap[g.id] = g
    }
    const condIds = [...new Set(Object.values(moradorMap).map(m => m.condominio_id).filter(Boolean))]
    if (condIds.length) {
      const { data: conds } = await supa.from('condominios').select('id, nome').in('id', condIds)
      for (const c of (conds || [])) condMap[c.id] = c.nome
    }

    const enriched = (logs || []).map(l => ({
      ...l,
      morador_nome: moradorMap[l.morador_id]?.nome || null,
      morador_foto: moradorMap[l.morador_id]?.foto_url || null,
      morador_bloco: moradorMap[l.morador_id]?.bloco || null,
      morador_unidade: moradorMap[l.morador_id]?.unidade || null,
      condominio_nome: condMap[moradorMap[l.morador_id]?.condominio_id] || null,
      geladeira_nome: geladeiraMap[l.geladeira_id]?.nome || null,
    }))

    const histograma = Array(24).fill(0)
    for (const l of (logs || [])) {
      const h = new Date(l.criado_em).getHours()
      histograma[h]++
    }

    res.json({ histograma, logs: enriched })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/admin/logs', async (req, res) => {
  try {
    const { tipo, resultado, limit = 50 } = req.query
    const supa = getDb()
    let q = supa.from('logs_acesso')
      .select('*')
      .order('criado_em', { ascending: false })
      .limit(parseInt(limit))
    if (tipo) q = q.eq('tipo', tipo)
    if (resultado) q = q.eq('resultado', resultado)
    const { data, error } = await q
    if (error) throw error

    const moradorIds = [...new Set((data || []).map(l => l.morador_id).filter(Boolean))]
    const geladeiraIds = [...new Set((data || []).map(l => l.geladeira_id).filter(Boolean))]
    const moradorMap = {}, geladeiraMap = {}
    if (moradorIds.length) {
      const { data: mors } = await supa.from('moradores').select('id, nome').in('id', moradorIds)
      for (const m of (mors || [])) moradorMap[m.id] = m
    }
    if (geladeiraIds.length) {
      const { data: gels } = await supa.from('geladeiras').select('id, nome').in('id', geladeiraIds)
      for (const g of (gels || [])) geladeiraMap[g.id] = g
    }

    const logs = (data || []).map(l => ({
      ...l,
      moradores: moradorMap[l.morador_id] ? { nome: moradorMap[l.morador_id].nome } : null,
      geladeiras: geladeiraMap[l.geladeira_id] ? { nome: geladeiraMap[l.geladeira_id].nome } : null,
    }))
    res.json({ logs })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/admin/geladeiras', async (req, res) => {
  try {
    const supa = getDb()
    const { data, error } = await supa.from('geladeiras').select('*, condominios(nome)').order('nome')
    if (error) throw error
    res.json({ geladeiras: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.patch('/admin/geladeiras/:id', async (req, res) => {
  try {
    const supa = getDb()
    const { data, error } = await supa.from('geladeiras').update(req.body).eq('id', req.params.id).select('*, condominios(nome)').single()
    if (error) throw error
    res.json({ geladeira: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/admin/condominios', async (req, res) => {
  try {
    const supa = getDb()
    const { data, error } = await supa.from('condominios').select('*').order('nome')
    if (error) throw error
    res.json({ condominios: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// ── BLOCOS ──
app.get('/admin/blocos/:condominioId', async (req, res) => {
  try {
    const blocos = await db.listarBlocosPorCondominio(req.params.condominioId)
    res.json({ blocos })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.patch('/admin/blocos/reordenar', async (req, res) => {
  try {
    const supa = getDb()
    const { ids } = req.body
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ erro: 'ids é obrigatório' })
    for (let i = 0; i < ids.length; i++) {
      const { error } = await supa.from('blocos').update({ ordem: i }).eq('id', ids[i])
      if (error) throw error
    }
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/blocos', async (req, res) => {
  try {
    const { condominio_id, nome } = req.body
    const supa = getDb()
    const { data, error } = await supa.from('blocos').insert([{ condominio_id, nome }]).select().single()
    if (error) throw error
    res.json({ bloco: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.patch('/admin/blocos/:id', async (req, res) => {
  try {
    const { nome } = req.body
    const supa = getDb()
    const { data, error } = await supa.from('blocos').update({ nome }).eq('id', req.params.id).select().single()
    if (error) throw error
    res.json({ bloco: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.delete('/admin/blocos/:id', async (req, res) => {
  try {
    const supa = getDb()
    const { error } = await supa.from('blocos').delete().eq('id', req.params.id)
    if (error) throw error
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/condominios', async (req, res) => {
  try {
    const supa = getDb()
    const { nome, flag_auto_aprovacao, idface_ip, idface_user, idface_senha } = req.body
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' })
    const { data, error } = await supa.from('condominios').insert([{ nome, flag_auto_aprovacao: !!flag_auto_aprovacao, idface_ip: idface_ip||null, idface_user: idface_user||null, idface_senha: idface_senha||null }]).select().single()
    if (error) throw error
    res.json({ condominio: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.patch('/admin/condominios/:id', async (req, res) => {
  try {
    const supa = getDb()
    const { data, error } = await supa.from('condominios').update(req.body).eq('id', req.params.id).select().single()
    if (error) throw error
    res.json({ condominio: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.delete('/admin/condominios/:id', async (req, res) => {
  try {
    const supa = getDb()
    const { error } = await supa.from('condominios').delete().eq('id', req.params.id)
    if (error) throw error
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// ── GELADEIRAS CRUD ──
app.post('/admin/geladeiras', async (req, res) => {
  try {
    const supa = getDb()
    const { nome, condominio_id, esp32_ip, flag_alcoolica } = req.body
    if (!nome || !condominio_id) return res.status(400).json({ erro: 'Nome e condomínio são obrigatórios' })
    const { data, error } = await supa.from('geladeiras').insert([{ nome, condominio_id, esp32_ip: esp32_ip||null, flag_alcoolica: !!flag_alcoolica }]).select('*, condominios(nome)').single()
    if (error) throw error
    res.json({ geladeira: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.delete('/admin/geladeiras/:id', async (req, res) => {
  try {
    const supa = getDb()
    const { error } = await supa.from('geladeiras').delete().eq('id', req.params.id)
    if (error) throw error
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// ── SEGURANÇA iDFACE ────────────────────────────────────────────

app.post('/admin/condominios/:id/idface-senha', async (req, res) => {
  try {
    const { novo_login, nova_senha } = req.body
    if (!nova_senha || nova_senha.length < 8) return res.status(400).json({ erro: 'Senha deve ter no mínimo 8 caracteres' })

    const supa = getDb()
    const { data: cond, error } = await supa.from('condominios').select('idface_ip, idface_senha, idface_user').eq('id', req.params.id).single()
    if (error || !cond) return res.status(404).json({ erro: 'Condomínio não encontrado' })
    if (!cond.idface_ip) return res.status(400).json({ erro: 'iDFace não configurado neste condomínio' })

    const { alterarSenhaWebIDFace } = require('./idface')
    const login = novo_login || cond.idface_user || 'admin'
    await alterarSenhaWebIDFace(cond.idface_ip, cond.idface_senha || 'admin', login, nova_senha, cond.idface_user || 'admin')

    await supa.from('condominios').update({ idface_senha: nova_senha, idface_user: login }).eq('id', req.params.id)
    res.json({ ok: true, mensagem: 'Senha web do iDFace alterada e salva no banco' })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/condominios/:id/idface-admin', async (req, res) => {
  try {
    const { cpf, pin } = req.body
    if (!cpf) return res.status(400).json({ erro: 'CPF do administrador é obrigatório' })
    if (pin && !/^\d{4,8}$/.test(pin)) return res.status(400).json({ erro: 'PIN deve ter entre 4 e 8 dígitos numéricos' })

    const supa = getDb()
    const { data: cond, error } = await supa.from('condominios').select('idface_ip, idface_senha, idface_user').eq('id', req.params.id).single()
    if (error || !cond) return res.status(404).json({ erro: 'Condomínio não encontrado' })
    if (!cond.idface_ip) return res.status(400).json({ erro: 'iDFace não configurado neste condomínio' })

    const { cadastrarAdminFisicoIDFace, cpfParaInt } = require('./idface')
    const userId = cpfParaInt(cpf)
    if (!userId) return res.status(400).json({ erro: 'CPF inválido' })

    const resultado = await cadastrarAdminFisicoIDFace(cond.idface_ip, cond.idface_senha || 'admin', userId, cond.idface_user || 'admin', pin || null)
    res.json(resultado)
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/condominios/:id/idface-ssh', async (req, res) => {
  try {
    const supa = getDb()
    const { data: cond, error } = await supa.from('condominios').select('idface_ip, idface_senha, idface_user').eq('id', req.params.id).single()
    if (error || !cond) return res.status(404).json({ erro: 'Condomínio não encontrado' })
    if (!cond.idface_ip) return res.status(400).json({ erro: 'iDFace não configurado neste condomínio' })

    const { desativarSSHIDFace } = require('./idface')
    await desativarSSHIDFace(cond.idface_ip, cond.idface_senha || 'admin', cond.idface_user || 'admin')
    res.json({ ok: true, mensagem: 'SSH desativado no iDFace' })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/admin/condominios/:id/idface-admins', async (req, res) => {
  try {
    const supa = getDb()
    const { data: cond, error } = await supa.from('condominios').select('idface_ip, idface_senha, idface_user').eq('id', req.params.id).single()
    if (error || !cond) return res.status(404).json({ erro: 'Condomínio não encontrado' })
    if (!cond.idface_ip) return res.status(400).json({ erro: 'iDFace não configurado neste condomínio' })

    const { listarAdminsIDFace } = require('./idface')
    const admins = await listarAdminsIDFace(cond.idface_ip, cond.idface_senha || 'admin', cond.idface_user || 'admin')
    res.json({ admins })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// ── QR CODES ─────────────────────────────────────────────────────
const QRCode = require('qrcode')

app.get('/qr/cadastro/:condominioId', async (req, res) => {
  try {
    const supa = getDb()
    const { data: cond, error } = await supa.from('condominios').select('nome').eq('id', req.params.condominioId).single()
    if (error || !cond) return res.status(404).json({ erro: 'Condomínio não encontrado' })
    const botNumero = config.BOT_NUMERO || config.META_PHONE_NUMBER_ID
    if (!botNumero) return res.status(500).json({ erro: 'BOT_NUMERO não configurado' })
    const texto = encodeURIComponent(`CADASTRO @${cond.nome}`)
    const url = `https://wa.me/${botNumero}?text=${texto}`
    const png = await QRCode.toBuffer(url, { width: 512, margin: 2 })
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Disposition', 'inline')
    res.send(png)
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/qr/geladeira/:geladeiraId', async (req, res) => {
  try {
    const supa = getDb()
    const { data: gel, error } = await supa.from('geladeiras').select('*, condominios(nome)').eq('id', req.params.geladeiraId).single()
    if (error || !gel) return res.status(404).json({ erro: 'Geladeira não encontrada' })
    const botNumero = config.BOT_NUMERO || config.META_PHONE_NUMBER_ID
    if (!botNumero) return res.status(500).json({ erro: 'BOT_NUMERO não configurado' })
    const texto = encodeURIComponent(`ABRIR ${gel.nome} @${gel.condominios?.nome || ''}`)
    const url = `https://wa.me/${botNumero}?text=${texto}`
    const png = await QRCode.toBuffer(url, { width: 512, margin: 2 })
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Disposition', 'inline')
    res.send(png)
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/painel', (req, res) => {
  res.sendFile(__dirname + '/painel.html')
})

app.get('/termos', (req, res) => {
  res.sendFile(__dirname + '/termos.html')
})

// ESP32/Pi polling endpoint
app.post('/esp32/heartbeat', async (req, res) => {
  res.sendStatus(200)
  try {
    const secret = req.headers['x-esp32-secret']
    if (secret !== config.ESP32_SECRET) return
    const { geladeira, ip, evento } = req.body
    if (!geladeira || !ip) return
    const supa = getDb()
    await supa.from('geladeiras').update({
      esp32_ip: ip,
      ultimo_heartbeat: new Date().toISOString(),
    }).ilike('nome', '%' + geladeira + '%')
    console.log('ESP32 heartbeat:', geladeira, 'IP:', ip, evento)
  } catch (err) {
    console.error('Erro heartbeat ESP32:', err)
  }
})

// ─── HELPERS ──────────────────────────────────────────────────────

function detectarTipo(msg) {
  if (msg.type === 'interactive') return 'interactive'
  if (msg.type === 'image') return 'image'
  if (msg.type === 'document') return 'document'
  if (msg.type === 'audio') return 'audio'
  if (msg.type === 'video') return 'video'
  return 'text'
}

function extrairTexto(msg, tipo) {
  if (tipo === 'text') return msg.text?.body || ''
  if (tipo === 'image') return msg.image?.caption || ''
  if (tipo === 'interactive') return msg.interactive?.button_reply?.title || ''
  return ''
}

function extrairButtonId(msg) {
  if (msg.type === 'interactive') {
    return msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null
  }
  return null
}

// ── CONVERSAS ──
app.get('/admin/conversas', async (req, res) => {
  try {
    const contatos = await db.listarContatosRecentes(50)
    const supa = getDb()
    const celulares = contatos.map(c => c.celular)
    const { data: moradores } = await supa.from('moradores').select('celular_whatsapp, nome, foto_url, condominios(nome)').in('celular_whatsapp', celulares)
    const nomeMap = {}
    for (const m of (moradores || [])) {
      nomeMap[m.celular_whatsapp] = { nome: m.nome, foto: m.foto_url, condominio: m.condominios?.nome || null }
    }
    const result = contatos.map(c => ({
      ...c,
      nome: nomeMap[c.celular]?.nome || null,
      foto: nomeMap[c.celular]?.foto || null,
      condominio: nomeMap[c.celular]?.condominio || null
    }))
    res.json({ contatos: result })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/conversas/:celular', async (req, res) => {
  try {
    const { texto } = req.body
    if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Texto é obrigatório' })
    const { enviarTexto } = require('./whatsapp')
    await enviarTexto(req.params.celular, texto.trim())
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/admin/conversas/:celular', async (req, res) => {
  try {
    const limite = parseInt(req.query.limite) || 50
    const msgs = await db.buscarMensagensPorCelular(req.params.celular, limite)
    res.json({ mensagens: msgs })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// ─── START ────────────────────────────────────────────────────────
app.listen(config.PORT, () => {
  console.log(`SelfStore Bot v2 rodando na porta ${config.PORT}`)
})
