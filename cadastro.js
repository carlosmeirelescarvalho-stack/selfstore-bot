// handlers/cadastro.js — fluxo 1 (cadastro de morador) v2

const db = require('./db')
const config = require('./config')
const { enviarTexto, enviarBotoes, notificarAdmin, MSG } = require('./whatsapp')
const { validarCPF, validarDataNascimento, validarNomeCompleto, validarUnidade, dataParaISO, formatarDataNasc } = require('./validacao')

async function handleCadastro(celular, mensagem, tipoMensagem, imagemBase64, buttonId) {
  try {
    const sessao = await db.buscarSessao(celular)

    if (!sessao) {
      await iniciarCadastro(celular)
      return
    }

    await processarEtapa(celular, mensagem, tipoMensagem, imagemBase64, buttonId, sessao)
  } catch (err) {
    console.error('Erro em handleCadastro:', err)
    await enviarTexto(celular, MSG.erroGeral())
  }
}

// Inicia cadastro pedindo condominio (se nao vier pre-definido)
async function iniciarCadastro(celular, condominioPreDefinido) {
  if (condominioPreDefinido) {
    const cond = await db.buscarCondominioPorNome(condominioPreDefinido)
    if (cond) {
      await db.salvarSessao(celular, 'termos', { condominio_id: cond.id, condominio_nome: cond.nome })
      await enviarBotoes(celular, MSG.termosCondicoes(config.LINK_TC), [
        { id: 'tc_aceito', titulo: 'Li e estou de acordo' },
        { id: 'tc_recusado', titulo: 'Não estou de acordo' },
      ])
      return
    }
  }

  const condominios = await db.listarCondominios()
  const lista = condominios.map((c, i) => `${i + 1}️⃣ ${c.nome}`).join('\n')
  await db.salvarSessao(celular, 'condominio', { _condominios: condominios })
  await enviarTexto(celular, MSG.selecionarCondominio(lista))
}

async function processarEtapa(celular, mensagem, tipoMensagem, imagemBase64, buttonId, sessao) {
  const etapa = sessao.etapa_atual
  const dados = sessao.dados_parciais || {}

  switch (etapa) {

    case 'condominio': {
      const condominios = dados._condominios || []
      const idx = parseInt(mensagem.trim()) - 1
      if (isNaN(idx) || idx < 0 || idx >= condominios.length) {
        await enviarTexto(celular, MSG.condominioInvalido())
        return
      }
      dados.condominio_id = condominios[idx].id
      dados.condominio_nome = condominios[idx].nome
      delete dados._condominios
      await db.salvarSessao(celular, 'termos', dados)
      await enviarBotoes(celular, MSG.termosCondicoes(config.LINK_TC), [
        { id: 'tc_aceito', titulo: 'Li e estou de acordo' },
        { id: 'tc_recusado', titulo: 'Não estou de acordo' },
      ])
      break
    }

    case 'termos': {
      if (buttonId === 'tc_recusado') {
        await enviarTexto(celular, MSG.termosRecusados())
        await db.deletarSessao(celular)
        return
      }
      if (buttonId === 'tc_aceito') {
        await db.salvarSessao(celular, 'nome', dados)
        await enviarTexto(celular, MSG.coletarNome())
        return
      }
      await enviarBotoes(celular, MSG.naoEntendidoFluxo0(), [
        { id: 'tc_aceito', titulo: 'Li e estou de acordo' },
        { id: 'tc_recusado', titulo: 'Não estou de acordo' },
      ])
      break
    }

    case 'nome': {
      const nome = mensagem.trim()
      if (!validarNomeCompleto(nome)) {
        await enviarTexto(celular, MSG.nomeInvalido())
        return
      }
      dados.nome = nome
      if (dados._corrigindo) return await voltarConfirmacao(celular, dados)
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
      const existeCPF = await db.buscarMoradorPorCPF(cpf)
      if (existeCPF) {
        await enviarTexto(celular, MSG.cpfJaCadastrado())
        return
      }
      dados.cpf = cpf
      if (dados._corrigindo) return await voltarConfirmacao(celular, dados)
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
      dados.data_nasc = mensagem.trim()
      if (dados._corrigindo) return await voltarConfirmacao(celular, dados)
      await db.salvarSessao(celular, 'bloco', dados)
      await enviarListaBlocos(celular, dados)
      break
    }

    case 'bloco': {
      const blocos = dados._blocos || []
      if (blocos.length > 0) {
        const idx = parseInt(mensagem.trim()) - 1
        if (isNaN(idx) || idx < 0 || idx >= blocos.length) {
          await enviarTexto(celular, MSG.blocoInvalido())
          return
        }
        dados.bloco = blocos[idx].nome
      } else {
        dados.bloco = mensagem.trim()
      }
      delete dados._blocos
      if (dados._corrigindo) return await voltarConfirmacao(celular, dados)
      await db.salvarSessao(celular, 'unidade', dados)
      await enviarTexto(celular, MSG.coletarUnidade())
      break
    }

    case 'unidade': {
      if (!validarUnidade(mensagem)) {
        await enviarTexto(celular, MSG.unidadeInvalida())
        return
      }
      dados.unidade = mensagem.trim()
      if (dados._corrigindo) return await voltarConfirmacao(celular, dados)
      await db.salvarSessao(celular, 'foto', dados)
      await enviarTexto(celular, MSG.coletarFoto())
      break
    }

    case 'foto': {
      if (tipoMensagem !== 'image' || !imagemBase64) {
        await enviarTexto(celular, MSG.fotoInvalida())
        return
      }
      let fotoUrl = null
      try {
        const buffer = Buffer.from(imagemBase64, 'base64')
        fotoUrl = await db.uploadFoto(celular, buffer, 'image/jpeg')
      } catch(e) { console.error('Erro upload foto:', e) }
      dados.foto_url = fotoUrl
      return await voltarConfirmacao(celular, dados)
    }

    case 'confirmar': {
      if (buttonId === 'confirmar_corrigir') {
        dados._corrigindo = true
        await db.salvarSessao(celular, 'corrigir', dados)
        await enviarTexto(celular, MSG.corrigirCampo())
        return
      }
      if (buttonId === 'confirmar_sim') {
        await finalizarCadastro(celular, dados, imagemBase64)
        return
      }
      await enviarBotoes(celular, 'Selecione uma opção:', [
        { id: 'confirmar_sim', titulo: 'Confirmar' },
        { id: 'confirmar_corrigir', titulo: 'Corrigir' },
      ])
      break
    }

    case 'corrigir': {
      const opcao = parseInt(mensagem.trim())
      const mapaEtapas = { 1: 'nome', 2: 'cpf', 3: 'data_nasc', 4: 'bloco', 5: 'unidade', 6: 'foto' }
      const etapaDestino = mapaEtapas[opcao]
      if (!etapaDestino) {
        await enviarTexto(celular, MSG.corrigirCampo())
        return
      }
      dados._corrigindo = true
      await db.salvarSessao(celular, etapaDestino, dados)
      const msgMap = {
        nome: MSG.coletarNome(),
        cpf: MSG.coletarCPF(),
        data_nasc: MSG.coletarDataNasc(),
        foto: MSG.coletarFoto(),
        unidade: MSG.coletarUnidade(),
      }
      if (etapaDestino === 'bloco') {
        await enviarListaBlocos(celular, dados)
      } else {
        await enviarTexto(celular, msgMap[etapaDestino])
      }
      break
    }

    default:
      await iniciarCadastro(celular)
  }
}

async function voltarConfirmacao(celular, dados) {
  delete dados._corrigindo
  await db.salvarSessao(celular, 'confirmar', dados)
  await enviarBotoes(
    celular,
    MSG.confirmarDados(dados.nome, dados.cpf, formatarDataNasc(dados.data_nasc), dados.bloco, dados.unidade, dados.condominio_nome),
    [
      { id: 'confirmar_sim', titulo: 'Confirmar' },
      { id: 'confirmar_corrigir', titulo: 'Corrigir' },
    ]
  )
}

async function enviarListaBlocos(celular, dados) {
  const blocos = await db.listarBlocosPorCondominio(dados.condominio_id)
  if (blocos.length > 0) {
    const lista = blocos.map((b, i) => `${i + 1}️⃣ ${b.nome}`).join('\n')
    dados._blocos = blocos
    await db.salvarSessao(celular, 'bloco', dados)
    await enviarTexto(celular, MSG.coletarBloco(lista))
  } else {
    await db.salvarSessao(celular, 'bloco', dados)
    await enviarTexto(celular, '🏗️ Qual é o seu *bloco*?\n\n_Ex: Bloco A, Torre 1_')
  }
}

async function finalizarCadastro(celular, dados, imagemBase64) {
  const condominios = await db.listarCondominios()
  const condominio = condominios.find(c => c.id === dados.condominio_id)
    || await db.buscarCondominioPorNome(dados.condominio_nome)

  const dataNascISO = dataParaISO(dados.data_nasc)
  const autoAprovacao = condominio?.flag_auto_aprovacao === true
  const status = autoAprovacao ? 'aprovado' : 'pendente'

  const morador = await db.criarMorador({
    nome: dados.nome,
    cpf: dados.cpf,
    data_nasc: dataNascISO,
    celular_whatsapp: celular,
    condominio_id: dados.condominio_id,
    bloco: dados.bloco,
    unidade: dados.unidade,
    foto_url: dados.foto_url || null,
    status,
    aceite_tc: true,
    criado_em: new Date().toISOString(),
  })

  await db.deletarSessao(celular)

  if (autoAprovacao) {
    try { await enviarTexto(celular, MSG.cadastroAprovadoAuto(dados.nome)) } catch(e) { console.error('Erro notif WhatsApp:', e.message) }
    await sincronizarComIDFace(morador, imagemBase64, condominio)
  } else {
    try { await enviarTexto(celular, MSG.cadastroEnviado()) } catch(e) { console.error('Erro notif WhatsApp:', e.message) }
    try {
      await notificarAdmin(
        `👤 *Novo cadastro pendente*\n\n` +
        `Nome: ${dados.nome}\n` +
        `CPF: ${dados.cpf}\n` +
        `Condomínio: ${dados.condominio_nome}\n` +
        `Bloco: ${dados.bloco} • Unidade: ${dados.unidade}\n` +
        `Celular: ${celular}\n\n` +
        `Acesse o painel para aprovar ou rejeitar.`,
        dados.condominio_id
      )
    } catch(e) { console.error('Erro notif admin:', e.message) }
  }
}

async function sincronizarComIDFace(morador, fotoBase64, condominio) {
  try {
    if (!condominio?.idface_ip || !condominio?.idface_senha) return
    const { cadastrarRostoIDFace } = require('./idface')
    await cadastrarRostoIDFace(
      condominio.idface_ip, condominio.idface_senha,
      morador, fotoBase64, condominio.idface_user || 'admin'
    )
    console.log(`iDFace: rosto cadastrado para morador ${morador.id}`)
  } catch (err) {
    console.error('Erro ao sincronizar com iDFace:', err)
  }
}

module.exports = { handleCadastro, sincronizarComIDFace, iniciarCadastro }
