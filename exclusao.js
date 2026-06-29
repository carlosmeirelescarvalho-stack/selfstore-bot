// handlers/exclusao.js — sub-fluxo exclusão de dados pessoais (LGPD Art. 18)

const db = require('./db')
const { enviarTexto, enviarBotoes, notificarAdmin, MSG } = require('./whatsapp')
const { removerUsuarioIDFace } = require('./idface')

async function handleExclusao(celular, buttonId) {
  if (buttonId === 'exclusao_confirmar') {
    await executarExclusao(celular)
    return true
  }

  if (buttonId === 'exclusao_cancelar') {
    await db.deletarSessao(celular)
    await enviarTexto(celular, MSG.exclusaoCancelada())
    return true
  }

  return false
}

async function iniciarExclusao(celular) {
  const morador = await db.buscarMoradorPorCelular(celular)
  if (!morador) {
    await enviarTexto(celular, 'Não encontramos um cadastro vinculado a este número.')
    return
  }

  await db.salvarSessao(celular, 'exclusao_confirmar', { morador_id: morador.id })
  await enviarBotoes(celular, MSG.confirmarExclusao(), [
    { id: 'exclusao_confirmar', titulo: 'Sim, excluir dados' },
    { id: 'exclusao_cancelar', titulo: 'Cancelar' },
  ])
}

async function executarExclusao(celular) {
  const morador = await db.buscarMoradorPorCelular(celular)
  if (!morador) {
    await db.deletarSessao(celular)
    await enviarTexto(celular, 'Não encontramos um cadastro vinculado a este número.')
    return
  }

  const condominio = morador.condominios

  // 1. Remover do iDFace (se configurado)
  if (condominio?.idface_ip && condominio?.idface_senha && morador.cpf) {
    try {
      await removerUsuarioIDFace(
        condominio.idface_ip,
        condominio.idface_senha,
        morador.cpf,
        condominio.idface_user || 'admin'
      )
      console.log(`Exclusão LGPD: iDFace removido para morador ${morador.id}`)
    } catch (err) {
      console.error('Exclusão LGPD: falha ao remover do iDFace:', err)
      await db.deletarSessao(celular)
      await enviarBotoes(celular, MSG.exclusaoFalha(), [
        { id: 'fluxo0_ajuda', titulo: 'Falar com suporte' },
      ])
      await notificarAdmin(
        `⚠️ *Falha na exclusão LGPD (iDFace)*\n\n` +
        `Morador: ${morador.nome} (ID: ${morador.id})\n` +
        `CPF: ${morador.cpf}\n` +
        `Condomínio: ${condominio?.nome || 'N/A'}\n` +
        `Erro: ${err.message}\n\n` +
        `Morador solicitou exclusão de dados mas a remoção do iDFace falhou. ` +
        `Dados no Supabase foram mantidos. Necessário exclusão manual do iDFace + Supabase.`,
        morador.condominio_id
      )
      return
    }
  }

  // 2. Remover foto do Supabase Storage + row do banco
  try {
    await db.excluirDadosMorador(morador.id, morador.foto_url, celular)
    console.log(`Exclusão LGPD: dados removidos do Supabase para morador ${morador.id}`)
  } catch (err) {
    console.error('Exclusão LGPD: falha ao remover do Supabase:', err)
    await db.deletarSessao(celular)
    await enviarBotoes(celular, MSG.exclusaoFalha(), [
      { id: 'fluxo0_ajuda', titulo: 'Falar com suporte' },
    ])
    await notificarAdmin(
      `⚠️ *Falha na exclusão LGPD (Supabase)*\n\n` +
      `Morador: ${morador.nome} (ID: ${morador.id})\n` +
      `Erro: ${err.message}\n\n` +
      `iDFace já foi removido mas Supabase falhou. Necessário exclusão manual no banco.`,
      morador.condominio_id
    )
    return
  }

  // 3. Limpar sessão e confirmar
  await db.deletarSessao(celular)
  await enviarTexto(celular, MSG.exclusaoConcluida())
  await notificarAdmin(
    `🗑️ *Exclusão de dados (LGPD Art. 18)*\n\n` +
    `Morador: ${morador.nome}\n` +
    `CPF: ${morador.cpf}\n` +
    `Condomínio: ${condominio?.nome || 'N/A'}\n` +
    `Bloco: ${morador.bloco} • Unidade: ${morador.unidade}\n\n` +
    `Dados removidos do iDFace e Supabase conforme solicitação do titular.`,
    morador.condominio_id
  )
}

module.exports = { handleExclusao, iniciarExclusao }
