// handlers/geladeira.js — fluxo 3 (abertura de geladeira) v2

const db = require('./db')
const config = require('./config')
const { enviarTexto, enviarBotoes, notificarAdmin, MSG } = require('./whatsapp')
const { isMaiorDeIdade } = require('./validacao')

function isComandoGeladeira(mensagem) {
  return mensagem.trim().toUpperCase().startsWith('ABRIR ')
}

async function handleGeladeira(celular, mensagem, buttonId) {
  try {
    const codigoGeladeira = mensagem.trim().substring(6).trim()
    if (!codigoGeladeira) {
      await enviarTexto(celular, MSG.erroGeral())
      return
    }

    const nomeCondominio = db.extrairCondominioDeComando(codigoGeladeira)
    const morador = await db.buscarMoradorPorCelular(celular)

    // 3.1 — Não cadastrado
    if (!morador) {
      await enviarBotoes(celular, MSG.geladeiraNaoCadastrado(), [
        { id: 'iniciar_cadastro', titulo: 'Fazer cadastro agora' },
      ])
      // Guarda contexto do condominio na sessao para uso no fluxo 1
      if (nomeCondominio) {
        await db.salvarSessao(celular, 'aguardando_cadastro_geladeira', { condominio_origem: nomeCondominio })
      }
      return
    }

    // 3.2 — Pendente
    if (morador.status === 'pendente') {
      await enviarTexto(celular, MSG.acessoNegadoPendente())
      await db.registrarLog(morador.id, null, 'whatsapp', 'negado', 'cadastro pendente')
      return
    }

    // 3.3 — Rejeitado
    if (morador.status === 'rejeitado') {
      await enviarTexto(celular, MSG.acessoNegadoRejeitado())
      await db.registrarLog(morador.id, null, 'whatsapp', 'negado', 'cadastro rejeitado')
      return
    }

    // 3.4 — Busca geladeira
    const geladeira = await db.buscarGeladeiraPorCodigo(codigoGeladeira)
    if (!geladeira) {
      await enviarTexto(celular, `❌ Geladeira não encontrada: *${codigoGeladeira}*.\n\nVerifique o QR Code e tente novamente.`)
      return
    }

    // 3.5 — Restrição álcool
    if (geladeira.flag_alcoolica && !isMaiorDeIdade(morador.data_nasc)) {
      await enviarTexto(celular, MSG.acessoNegadoMenor())
      await db.registrarLog(morador.id, geladeira.id, 'whatsapp', 'negado', 'menor de idade')
      return
    }

    // 3.6 — Aceite T&C
    if (!morador.aceite_tc) {
      await db.salvarSessao(celular, 'geladeira_tc', {
        geladeira_codigo: codigoGeladeira,
        geladeira_id: geladeira.id,
        morador_id: morador.id,
      })
      await enviarBotoes(celular, MSG.geladeiraAceiteTCNecessario(config.LINK_TC), [
        { id: 'tc_geladeira_aceito', titulo: 'Li e estou de acordo' },
        { id: 'tc_geladeira_recusado', titulo: 'Não estou de acordo' },
      ])
      return
    }

    // 3.7 — Em manutenção
    if (geladeira.status === 'manutencao') {
      await enviarTexto(celular, MSG.geladeiraEmManutencao())
      await db.registrarLog(morador.id, geladeira.id, 'whatsapp', 'negado', 'manutenção')
      return
    }

    // 3.8 — Pi não configurado
    if (!geladeira.esp32_ip) {
      await enviarTexto(celular, '⚠️ Esta geladeira ainda não está configurada. Informe o administrador.')
      await notificarAdmin(
        `⚠️ *Geladeira sem dispositivo*\n\n` +
        `Geladeira: ${geladeira.nome}\n` +
        `Morador tentou abrir: ${morador.nome} (${celular})\n` +
        `Condomínio: ${geladeira.condominios?.nome || 'N/A'}`,
        geladeira.condominio_id
      )
      return
    }

    // 3.9 — Abre via INSERT na tabela comandos_esp32 (Pi faz polling)
    await db.inserirComandoGeladeira(geladeira.id, morador.id)

    // 3.10 — Confirma
    await enviarTexto(celular, MSG.geladeiraAberta(geladeira.nome))
    await db.registrarLog(morador.id, geladeira.id, 'whatsapp', 'aberto', null)

  } catch (err) {
    console.error('Erro em handleGeladeira:', err)
    await enviarTexto(celular, MSG.erroGeral())
  }
}

// Handler para aceite T&C da geladeira (chamado pelo index quando buttonId = tc_geladeira_*)
async function handleGeladeiraTC(celular, buttonId) {
  const sessao = await db.buscarSessao(celular)
  if (!sessao || sessao.etapa_atual !== 'geladeira_tc') return false

  const dados = sessao.dados_parciais || {}

  if (buttonId === 'tc_geladeira_recusado') {
    await enviarTexto(celular, MSG.geladeiraAceiteTCRecusado())
    await db.deletarSessao(celular)
    return true
  }

  if (buttonId === 'tc_geladeira_aceito') {
    await db.atualizarAceiteTCMorador(dados.morador_id)
    await db.deletarSessao(celular)
    // Refaz a abertura agora que T&C foi aceito
    await handleGeladeira(celular, `ABRIR ${dados.geladeira_codigo}`, null)
    return true
  }

  return false
}

module.exports = { handleGeladeira, isComandoGeladeira, handleGeladeiraTC }
