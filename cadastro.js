// handlers/cadastro.js — fluxo 1 completo

const db = require('./db')
const { enviarTexto, notificarAdmin, transferirParaHumano, MSG } = require('./whatsapp')
const { validarCPF, validarDataNascimento, isMaiorDeIdade, validarTelefone, normalizarCelular } = require('./validacao')

// Etapas do cadastro em ordem
const ETAPAS = ['nome', 'cpf', 'data_nasc', 'telefone', 'condominio', 'bloco', 'unidade', 'foto']

async function handleCadastro(celular, mensagem, tipoMensagem, imagemBase64) {
  try {
    // Verifica se já está cadastrado
    const moradorExistente = await db.buscarMoradorPorCelular(celular)

    if (moradorExistente) {
      // Verifica se está no meio de uma conversa sobre ajuste
      const sessao = await db.buscarSessao(celular)
      if (sessao && sessao.etapa_atual === 'aguardando_ajuste') {
        return handleRespostaAjuste(celular, mensagem, moradorExistente, sessao)
      }

      // Primeira vez que chega como já cadastrado
      await enviarTexto(celular, MSG.jaCadastrado(moradorExistente.nome))
      await db.salvarSessao(celular, 'aguardando_ajuste', { morador_id: moradorExistente.id })
      return
    }

    // Verifica se já tem sessão de cadastro em andamento
    const sessao = await db.buscarSessao(celular)

    if (!sessao) {
      // Início do cadastro — inicia com coleta de nome
      await iniciarCadastro(celular)
      return
    }

    // Continua de onde parou
    await processarEtapa(celular, mensagem, tipoMensagem, imagemBase64, sessao)

  } catch (err) {
    console.error('Erro em handleCadastro:', err)
    await enviarTexto(celular, MSG.erroGeral())
  }
}

async function iniciarCadastro(celular) {
  await db.salvarSessao(celular, 'nome', {})
  await enviarTexto(celular, MSG.coletarNome())
}

async function processarEtapa(celular, mensagem, tipoMensagem, imagemBase64, sessao) {
  const etapa = sessao.etapa_atual
  const dados = sessao.dados_parciais || {}

  switch (etapa) {

    case 'nome': {
      const nome = mensagem.trim()
      if (nome.length < 3) {
        await enviarTexto(celular, `❌ Nome muito curto. Por favor, envie seu nome completo.`)
        return
      }
      dados.nome = nome
      await db.salvarSessao(celular, 'cpf', dados)
      await enviarTexto(celular, MSG.coletarCPF())
      break
    }

    case 'cpf': {
      const cpf = mensagem.replace(/\D/g, '')
      if (!validarCPF(cpf)) {
        await enviarTexto(celular, MSG.cpfInvalido())
        return
      }
      // Verifica duplicidade de CPF
      const existeCPF = await db.buscarMoradorPorCPF(cpf)
      if (existeCPF) {
        await enviarTexto(celular, MSG.cpfJaCadastrado())
        return
      }
      dados.cpf = cpf
      await db.salvarSessao(celular, 'data_nasc', dados)
      await enviarTexto(celular, MSG.coletarDataNasc())
      break
    }

    case 'data_nasc': {
      const validacao = validarDataNascimento(mensagem.trim())
      if (!validacao.valida) {
        await enviarTexto(celular, MSG.dataNascInvalida())
        return
      }
      if (!isMaiorDeIdade(mensagem.trim())) {
        await db.deletarSessao(celular)
        await enviarTexto(celular, MSG.menorDeIdade())
        return
      }
      dados.data_nasc = mensagem.trim()
      await db.salvarSessao(celular, 'telefone', dados)
      await enviarTexto(celular, MSG.coletarTelefone())
      break
    }

    case 'telefone': {
      if (!validarTelefone(mensagem)) {
        await enviarTexto(celular, MSG.telefoneInvalido())
        return
      }
      dados.telefone = mensagem.replace(/\D/g, '')
      await db.salvarSessao(celular, 'condominio', dados)

      // Lista condomínios disponíveis
      const condominios = await db.listarCondominios()
      const lista = condominios.map((c, i) => `${i + 1}️⃣ ${c.nome}`).join('\n')
      dados._condominios = condominios // salva para referência na próxima etapa
      await db.salvarSessao(celular, 'condominio', dados)
      await enviarTexto(celular, MSG.coletarCondominio(lista))
      break
    }

    case 'condominio': {
      const condominios = dados._condominios || []
      const idx = parseInt(mensagem.trim()) - 1
      if (isNaN(idx) || idx < 0 || idx >= condominios.length) {
        await enviarTexto(celular, MSG.condominioInvalido())
        return
      }
      dados.condominio_id = condominios[idx].id
      dados.condominio_nome = condominios[idx].nome
      delete dados._condominios // limpa dado temporário
      await db.salvarSessao(celular, 'bloco', dados)
      await enviarTexto(celular, MSG.coletarBloco())
      break
    }

    case 'bloco': {
      dados.bloco = mensagem.trim()
      await db.salvarSessao(celular, 'unidade', dados)
      await enviarTexto(celular, MSG.coletarUnidade())
      break
    }

    case 'unidade': {
      dados.unidade = mensagem.trim()
      await db.salvarSessao(celular, 'foto', dados)
      await enviarTexto(celular, MSG.coletarFoto())
      break
    }

    case 'foto': {
      if (tipoMensagem !== 'image' || !imagemBase64) {
        await enviarTexto(celular, MSG.fotoInvalida())
        return
      }
      await finalizarCadastro(celular, dados, imagemBase64)
      break
    }

    default:
      await iniciarCadastro(celular)
  }
}

async function finalizarCadastro(celular, dados, imagemBase64) {
  // 1. Faz upload da foto para o Supabase Storage
  let fotoUrl = null
  try {
    let buffer
    if (typeof imagemBase64 === 'string' && imagemBase64.startsWith('http')) {
      // É uma URL — faz download e converte
      const res = await fetch(imagemBase64)
      const ab = await res.arrayBuffer()
      buffer = Buffer.from(ab)
    } else if (typeof imagemBase64 === 'string') {
      buffer = Buffer.from(imagemBase64, 'base64')
    } else {
      buffer = Buffer.from(imagemBase64)
    }
    fotoUrl = await db.uploadFoto(celular, buffer, 'image/jpeg')
  } catch(e) {
    console.error('Erro ao processar foto:', e)
    // Continua sem foto — admin pode adicionar depois
  }

  // 2. Busca condomínio para saber flag de auto-aprovação
  const condominios = await db.listarCondominios()
  const condominio = condominios.find(c => c.id === dados.condominio_id)
    || await db.buscarCondominioPorNome(dados.condominio_nome)

  // Converte data DD/MM/YYYY para YYYY-MM-DD para o banco
  const [dia, mes, ano] = dados.data_nasc.split('/')
  const dataNascISO = `${ano}-${mes.padStart(2,'0')}-${dia.padStart(2,'0')}`

  const autoAprovacao = condominio?.flag_auto_aprovacao === true
  const status = autoAprovacao ? 'aprovado' : 'pendente'

  // 3. Cria morador no banco
  const morador = await db.criarMorador({
    nome: dados.nome,
    cpf: dados.cpf,
    data_nasc: dataNascISO,
    telefone: dados.telefone,
    celular_whatsapp: celular,
    condominio_id: dados.condominio_id,
    bloco: dados.bloco,
    unidade: dados.unidade,
    foto_url: fotoUrl,
    status,
    criado_em: new Date().toISOString(),
  })

  // 4. Limpa a sessão
  await db.deletarSessao(celular)

  if (autoAprovacao) {
    // 5a. Aprovação automática → cadastra no iDFace imediatamente
    try { await enviarTexto(celular, MSG.cadastroAprovadoAuto(dados.nome)) } catch(e) { console.error('Erro ao notificar aprovacao WhatsApp:', e.message) }
    await sincronizarComIDFace(morador, imagemBase64, condominio)
  } else {
    // 5b. Aprovação manual → notifica admin
    try { await enviarTexto(celular, MSG.cadastroEnviado()) } catch(e) { console.error('Erro ao notificar cadastro WhatsApp:', e.message) }
    try { await notificarAdmin(
      `👤 *Novo cadastro pendente*\n\n` +
      `Nome: ${dados.nome}\n` +
      `CPF: ${dados.cpf}\n` +
      `Condomínio: ${dados.condominio_nome}\n` +
      `Bloco: ${dados.bloco} • Unidade: ${dados.unidade}\n` +
      `Celular: ${celular}\n\n` +
      `Acesse o painel para aprovar ou rejeitar.`
    ) } catch(e) { console.error('Erro ao notificar admin WhatsApp:', e.message) }
  }
}

async function sincronizarComIDFace(morador, fotoBase64, condominio) {
  try {
    if (!condominio?.idface_ip || !condominio?.idface_senha) {
      console.warn('iDFace não configurado para este condomínio')
      return
    }
    // Importa idface de forma lazy para evitar dependência circular
    const { cadastrarRostoIDFace } = require('./idface')
    await cadastrarRostoIDFace(
      condominio.idface_ip,
      condominio.idface_senha,
      morador,
      fotoBase64,
      condominio.idface_user || 'admin'
    )
    console.log(`Rosto cadastrado no iDFace para morador ${morador.id}`)
  } catch (err) {
    console.error('Erro ao sincronizar com iDFace:', err)
  }
}

async function handleRespostaAjuste(celular, mensagem, morador, sessao) {
  const resp = mensagem.trim()

  if (resp === '1' || resp.toLowerCase().includes('sim')) {
    await db.deletarSessao(celular)
    await transferirParaHumano(celular, morador.nome)
  } else {
    await db.deletarSessao(celular)
    await enviarTexto(celular, `👍 Tudo certo, ${morador.nome}! Se precisar de algo, é só chamar.`)
  }
}

// Exporta também a função de sincronização para uso pelo painel admin
module.exports = { handleCadastro, sincronizarComIDFace }
