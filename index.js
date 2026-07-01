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
  res.header('Access-Control-Allow-Headers', 'Content-Type,X-ESP32-Secret')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

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
  await notificarAdmin(
    `📲 *Solicitação de atendimento*\n\n` +
    `Nome: ${dados.nome_atendimento || 'N/A'}\n` +
    `Celular: ${celular}\n` +
    `Motivo: ${texto}\n` +
    `Horário: ${hora}`
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
    await db.registrarLog(evento.user_id, null, 'facial',
      negado ? 'negado' : 'aberto',
      negado ? evento.result : null)

    if (negado) {
      const morador = await db.buscarMoradorPorCpfNumerico(evento.user_id)
      if (morador && morador.status === 'bloqueado' && podeAlertarBloqueio(morador.id)) {
        const hora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        await notificarAdmin(
          `⚠️ *Tentativa de acesso — morador bloqueado*\n\n` +
          `Morador: ${morador.nome}\n` +
          `Via: Reconhecimento facial (iDFace)\n` +
          `Horário: ${hora}`,
          morador.condominio_id
        )
      }
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
    if (morador?.foto_url && morador?.condominios?.idface_ip) {
      try {
        const { removerRostoIDFace } = require('./idface')
        if (removerRostoIDFace) await removerRostoIDFace(morador.condominios.idface_ip, morador.condominios.idface_senha, morador.id, morador.condominios.idface_user || 'admin')
      } catch(e) { console.error('Erro ao remover do iDFace:', e.message) }
    }
    await db.deletarMorador(req.params.id)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.post('/admin/moradores', async (req, res) => {
  try {
    const resultado = await cadastrarManual(req.body)
    if (resultado.erro) return res.status(400).json({ erro: resultado.erro })
    res.json(resultado)
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

app.get('/admin/logs', async (req, res) => {
  try {
    const { tipo, resultado, limit = 50 } = req.query
    const supa = getDb()
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

app.patch('/admin/condominios/:id', async (req, res) => {
  try {
    const supa = getDb()
    const { data, error } = await supa.from('condominios').update(req.body).eq('id', req.params.id).select().single()
    if (error) throw error
    res.json({ condominio: data })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

// ── QR CODES ─────────────────────────────────────────────────────
const QRCode = require('qrcode')

app.get('/qr/cadastro/:condominioId', async (req, res) => {
  try {
    const supa = getSupa()
    const { data: cond, error } = await supa.from('condominios').select('nome').eq('id', req.params.condominioId).single()
    if (error || !cond) return res.status(404).json({ erro: 'Condomínio não encontrado' })
    const botNumero = config.BOT_NUMERO || config.META_PHONE_NUMBER_ID
    const texto = encodeURIComponent(`CADASTRO @${cond.nome}`)
    const url = `https://wa.me/${botNumero}?text=${texto}`
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Disposition', `attachment; filename="qr-cadastro-${cond.nome.replace(/\s+/g, '-').toLowerCase()}.png"`)
    await QRCode.toFileStream(res, url, { width: 512, margin: 2 })
  } catch (err) { res.status(500).json({ erro: err.message }) }
})

app.get('/qr/geladeira/:geladeiraId', async (req, res) => {
  try {
    const supa = getSupa()
    const { data: gel, error } = await supa.from('geladeiras').select('*, condominios(nome)').eq('id', req.params.geladeiraId).single()
    if (error || !gel) return res.status(404).json({ erro: 'Geladeira não encontrada' })
    const botNumero = config.BOT_NUMERO || config.META_PHONE_NUMBER_ID
    const texto = encodeURIComponent(`ABRIR ${gel.nome} @${gel.condominios?.nome || ''}`)
    const url = `https://wa.me/${botNumero}?text=${texto}`
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Disposition', `attachment; filename="qr-geladeira-${gel.nome.replace(/\s+/g, '-').toLowerCase()}.png"`)
    await QRCode.toFileStream(res, url, { width: 512, margin: 2 })
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

// ─── START ────────────────────────────────────────────────────────
app.listen(config.PORT, () => {
  console.log(`SelfStore Bot v2 rodando na porta ${config.PORT}`)
})
