// admin-whatsapp.js — menu admin via WhatsApp v2

const db = require('./db')
const config = require('./config')
const { enviarTexto, enviarBotoes, notificarAdmin, MSG } = require('./whatsapp')
const { validarCPF, validarDataNascimento, validarNomeCompleto, validarUnidade, normalizarCelular, dataParaISO, formatarDataNasc, numEmoji } = require('./validacao')

async function isAdmin(celular) {
  const admins = await db.listarAdmins()
  return admins.some(a => a.celular === celular && a.ativo)
}

function isComandoAdmin(texto) {
  const t = texto.trim().toUpperCase()
  return t === 'ADMIN' || t === 'MENU ADMIN' || t === 'ADM'
}

async function handleAdmin(celular, mensagem, tipoMensagem, imagemBase64, buttonId) {
  try {
    const sessao = await db.buscarSessao(`admin_${celular}`)
    const texto = mensagem.trim()

    if (!sessao) {
      if (isComandoAdmin(texto)) {
        await mostrarMenuPrincipal(celular)
        return 'ok'
      }
      return 'continuar'
    }

    const etapa = sessao.etapa_atual
    const dados = sessao.dados_parciais || {}

    if (texto.toUpperCase() === 'SAIR' || texto === '0') {
      await encerrarSessaoAdmin(celular)
      return 'ok'
    }

    if (etapa === 'menu') {
      switch (texto) {
        case '1': await listarPendentes(celular); break
        case '2': await iniciarAprovacao(celular); break
        case '3': await iniciarRejeicao(celular); break
        case '4': await iniciarBloqueio(celular); break
        case '5': await iniciarCadastroAdmin(celular); break
        default:
          await enviarTexto(celular, 'Opção inválida. Responda com um número de 1 a 5 ou *0* para sair.')
      }
      return 'ok'
    }

    if (etapa === 'aprovar_busca') { await buscarMoradorParaAprovar(celular, texto); return 'ok' }
    if (etapa === 'aprovar_confirmar') { await confirmarAprovacao(celular, texto, dados); return 'ok' }
    if (etapa === 'rejeitar_busca') { await buscarMoradorParaRejeitar(celular, texto); return 'ok' }
    if (etapa === 'rejeitar_confirmar') { await confirmarRejeicao(celular, texto, dados); return 'ok' }
    if (etapa === 'bloquear_busca') { await buscarMoradorParaBloquear(celular, texto); return 'ok' }
    if (etapa === 'bloquear_confirmar') { await confirmarBloqueio(celular, texto, dados); return 'ok' }

    if (etapa.startsWith('cadastro_')) {
      await processarCadastroAdmin(celular, texto, tipoMensagem, imagemBase64, buttonId, sessao)
      return 'ok'
    }

    return 'ok'
  } catch (err) {
    console.error('Erro handleAdmin:', err)
    await enviarTexto(celular, MSG.erroGeral())
    return 'ok'
  }
}

// ─── MENU PRINCIPAL ───────────────────────────────
async function mostrarMenuPrincipal(celular) {
  const pendentes = await db.contarPendentes()
  await db.salvarSessao(`admin_${celular}`, 'menu', {})
  await enviarTexto(celular,
    `🔐 *Menu Admin SelfStore*\n\n` +
    `1️⃣ Ver pendentes${pendentes > 0 ? ` *(${pendentes})*` : ''}\n` +
    `2️⃣ Aprovar morador\n` +
    `3️⃣ Rejeitar morador\n` +
    `4️⃣ Bloquear morador\n` +
    `5️⃣ Cadastrar morador\n` +
    `0️⃣ Sair\n\n` +
    `_Responda com o número_`
  )
}

async function encerrarSessaoAdmin(celular) {
  await db.deletarSessao(`admin_${celular}`)
  await enviarTexto(celular, '✅ Menu admin encerrado.')
}

// ─── LISTAR PENDENTES ─────────────────────────────
async function listarPendentes(celular) {
  const pendentes = await db.listarMoradoresPorStatus('pendente')
  if (pendentes.length === 0) {
    await enviarTexto(celular, '✅ Nenhum cadastro pendente.')
    await mostrarMenuPrincipal(celular)
    return
  }
  const lista = pendentes.slice(0, 10).map((m, i) =>
    `${i + 1}. *${m.nome}*\n   ${m.bloco} • Apto ${m.unidade} • ${m.condominios?.nome || ''}`
  ).join('\n\n')
  await enviarTexto(celular, `⏳ *Pendentes:*\n\n${lista}\n\nUse *2* para aprovar ou *3* para rejeitar.`)
  await mostrarMenuPrincipal(celular)
}

// ─── APROVAÇÃO ────────────────────────────────────
async function iniciarAprovacao(celular) {
  await db.salvarSessao(`admin_${celular}`, 'aprovar_busca', {})
  await enviarTexto(celular, 'Digite o *celular* ou *nome* do morador para aprovar:')
}

async function buscarMoradorParaAprovar(celular, busca) {
  const morador = await db.buscarMoradorParaAcao(busca)
  if (!morador) { await enviarTexto(celular, '❌ Morador não encontrado.'); return }
  await db.salvarSessao(`admin_${celular}`, 'aprovar_confirmar', {
    morador_id: morador.id, morador_nome: morador.nome,
    morador_celular: morador.celular_whatsapp,
    foto_url: morador.foto_url, condominio: morador.condominios,
    bloco: morador.bloco, unidade: morador.unidade,
  })
  await enviarTexto(celular,
    `Confirma aprovação de *${morador.nome}*?\n` +
    `${morador.bloco} • Apto ${morador.unidade}\n\nResponda *SIM* ou *NÃO*.`
  )
}

async function confirmarAprovacao(celular, resposta, dados) {
  if (resposta.toUpperCase() === 'SIM') {
    await db.atualizarStatusMorador(dados.morador_id, 'aprovado')

    let syncOk = false
    if (dados.foto_url && dados.condominio?.idface_ip) {
      try {
        const morador = await db.buscarMoradorPorCelular(dados.morador_celular)
        if (morador?.cpf) {
          const { cadastrarRostoIDFace, urlParaBase64 } = require('./idface')
          const fotoBase64 = await urlParaBase64(dados.foto_url)
          await cadastrarRostoIDFace(dados.condominio.idface_ip, dados.condominio.idface_senha,
            morador, fotoBase64, dados.condominio.idface_user || 'admin')
          syncOk = true
        } else {
          console.error('iDFace sync ignorado: morador sem CPF', dados.morador_id)
        }
      } catch (e) {
        console.error('Erro iDFace:', e)
        await enviarTexto(celular, `⚠️ Falha no sync iDFace para *${dados.morador_nome}*: ${e.message}\nO morador foi aprovado mas o reconhecimento facial não foi registrado.`)
      }
    }

    if (dados.morador_celular) {
      if (syncOk || !dados.condominio?.idface_ip) {
        await enviarTexto(dados.morador_celular, MSG.cadastroAprovadoAuto(dados.morador_nome))
      } else {
        await enviarBotoes(dados.morador_celular, MSG.cadastroAprovadoSemFace(dados.morador_nome), [
          { id: 'fluxo0_ajuda', titulo: 'Falar com suporte' },
        ])
      }
    }

    await enviarTexto(celular, `✅ *${dados.morador_nome}* aprovado!${syncOk ? ' (facial registrado)' : ''}`)
  } else {
    await enviarTexto(celular, 'Cancelado.')
  }
  await mostrarMenuPrincipal(celular)
}

// ─── REJEIÇÃO ─────────────────────────────────────
async function iniciarRejeicao(celular) {
  await db.salvarSessao(`admin_${celular}`, 'rejeitar_busca', {})
  await enviarTexto(celular, 'Digite o *celular* ou *nome* do morador para rejeitar:')
}

async function buscarMoradorParaRejeitar(celular, busca) {
  const morador = await db.buscarMoradorParaAcao(busca)
  if (!morador) { await enviarTexto(celular, '❌ Morador não encontrado.'); return }
  await db.salvarSessao(`admin_${celular}`, 'rejeitar_confirmar',
    { morador_id: morador.id, morador_nome: morador.nome, morador_celular: morador.celular_whatsapp })
  await enviarTexto(celular, `Confirma *rejeição* de *${morador.nome}*?\n\nResponda *SIM* ou *NÃO*.`)
}

async function confirmarRejeicao(celular, resposta, dados) {
  if (resposta.toUpperCase() === 'SIM') {
    await db.atualizarStatusMorador(dados.morador_id, 'rejeitado')
    if (dados.morador_celular) await enviarTexto(dados.morador_celular, MSG.acessoNegadoRejeitado())
    await enviarTexto(celular, `✅ *${dados.morador_nome}* rejeitado.`)
  } else {
    await enviarTexto(celular, 'Cancelado.')
  }
  await mostrarMenuPrincipal(celular)
}

// ─── BLOQUEIO ─────────────────────────────────────
async function iniciarBloqueio(celular) {
  await db.salvarSessao(`admin_${celular}`, 'bloquear_busca', {})
  await enviarTexto(celular, 'Digite o *celular* ou *nome* do morador para bloquear:')
}

async function buscarMoradorParaBloquear(celular, busca) {
  const morador = await db.buscarMoradorParaAcao(busca)
  if (!morador) { await enviarTexto(celular, '❌ Morador não encontrado.'); return }
  await db.salvarSessao(`admin_${celular}`, 'bloquear_confirmar',
    { morador_id: morador.id, morador_nome: morador.nome, morador_celular: morador.celular_whatsapp })
  await enviarTexto(celular, `Confirma *bloqueio* de *${morador.nome}*?\nO acesso será suspenso.\n\nResponda *SIM* ou *NÃO*.`)
}

async function confirmarBloqueio(celular, resposta, dados) {
  if (resposta.toUpperCase() === 'SIM') {
    await db.atualizarStatusMorador(dados.morador_id, 'bloqueado')
    if (dados.morador_celular) {
      await enviarBotoes(dados.morador_celular, MSG.acessoBloqueado(), [
        { id: 'fluxo0_ajuda', titulo: 'Falar com suporte' },
      ])
    }
    await enviarTexto(celular, `✅ *${dados.morador_nome}* bloqueado.`)
  } else {
    await enviarTexto(celular, 'Cancelado.')
  }
  await mostrarMenuPrincipal(celular)
}

// ─── CADASTRO MANUAL (4E) v2 ──────────────────────
async function iniciarCadastroAdmin(celular) {
  await db.salvarSessao(`admin_${celular}`, 'cadastro_nome', {})
  await enviarTexto(celular,
    '📝 *Cadastro de morador*\n\nQual é o *nome completo* do morador?\n\n_Responda SAIR a qualquer momento para cancelar_')
}

async function processarCadastroAdmin(celular, texto, tipoMensagem, imagemBase64, buttonId, sessao) {
  const etapa = sessao.etapa_atual
  const dados = sessao.dados_parciais || {}
  const sk = `admin_${celular}`

  switch (etapa) {

    case 'cadastro_nome': {
      if (!validarNomeCompleto(texto)) {
        await enviarTexto(celular, 'Por favor, informe *nome e sobrenome* (mínimo 2 palavras).')
        return
      }
      dados.nome = texto
      await db.salvarSessao(sk, 'cadastro_cpf', dados)
      await enviarTexto(celular, 'CPF do morador:')
      break
    }

    case 'cadastro_cpf': {
      if (!validarCPF(texto)) { await enviarTexto(celular, 'CPF inválido.'); return }
      const existente = await db.buscarMoradorPorCPF(texto)
      if (existente) { await enviarTexto(celular, '❌ CPF já cadastrado.'); return }
      dados.cpf = texto.replace(/\D/g, '')
      await db.salvarSessao(sk, 'cadastro_nasc', dados)
      await enviarTexto(celular, 'Data de nascimento (DD/MM/AAAA):')
      break
    }

    case 'cadastro_nasc': {
      const v = validarDataNascimento(texto)
      if (!v.valida) { await enviarTexto(celular, 'Data inválida. Use DD/MM/AAAA.'); return }
      dados.data_nasc = texto
      await db.salvarSessao(sk, 'cadastro_celular', dados)
      await enviarTexto(celular, 'Celular do morador (com DDD):')
      break
    }

    case 'cadastro_celular': {
      const celularNorm = normalizarCelular(texto)
      if (!celularNorm) { await enviarTexto(celular, 'Celular inválido. Informe com DDD.'); return }
      dados.celular_whatsapp = celularNorm

      const condominios = await db.listarCondominios()
      const lista = condominios.map((c, i) => `${numEmoji(i + 1)} ${c.nome}`).join('\n')
      dados._condominios = condominios
      await db.salvarSessao(sk, 'cadastro_condominio', dados)
      await enviarTexto(celular, `Condomínio:\n\n${lista}\n\n_Digite o número_`)
      break
    }

    case 'cadastro_condominio': {
      const condominios = dados._condominios || []
      const idx = parseInt(texto) - 1
      if (isNaN(idx) || idx < 0 || idx >= condominios.length) {
        await enviarTexto(celular, 'Opção inválida.')
        return
      }
      dados.condominio_id = condominios[idx].id
      dados.condominio_nome = condominios[idx].nome
      delete dados._condominios

      const blocos = await db.listarBlocosPorCondominio(dados.condominio_id)
      if (blocos.length > 0) {
        const lista = blocos.map((b, i) => `${numEmoji(i + 1)} ${b.nome}`).join('\n')
        dados._blocos = blocos
        await db.salvarSessao(sk, 'cadastro_bloco', dados)
        await enviarTexto(celular, `Bloco:\n\n${lista}\n\n_Digite o número_`)
      } else {
        await db.salvarSessao(sk, 'cadastro_bloco', dados)
        await enviarTexto(celular, 'Bloco do morador:')
      }
      break
    }

    case 'cadastro_bloco': {
      const blocos = dados._blocos || []
      if (blocos.length > 0) {
        const idx = parseInt(texto) - 1
        if (isNaN(idx) || idx < 0 || idx >= blocos.length) {
          await enviarTexto(celular, 'Opção inválida. Escolha um número da lista.')
          return
        }
        dados.bloco = blocos[idx].nome
      } else {
        dados.bloco = texto
      }
      delete dados._blocos
      await db.salvarSessao(sk, 'cadastro_unidade', dados)
      await enviarTexto(celular, 'Unidade/apartamento:')
      break
    }

    case 'cadastro_unidade': {
      if (!validarUnidade(texto)) {
        await enviarTexto(celular, 'O apartamento precisa conter um número.')
        return
      }
      dados.unidade = texto.trim()
      await db.salvarSessao(sk, 'cadastro_foto', dados)
      await enviarTexto(celular,
        '📸 Envie uma *foto do rosto* do morador.\n\nSe não tiver agora, responda *PULAR*.')
      break
    }

    case 'cadastro_foto': {
      let fotoUrl = null
      if (tipoMensagem === 'image' && imagemBase64) {
        const buffer = Buffer.from(imagemBase64, 'base64')
        fotoUrl = await db.uploadFoto(dados.celular_whatsapp || celular, buffer, 'image/jpeg')
      } else if (texto.toUpperCase() !== 'PULAR') {
        await enviarTexto(celular, 'Envie uma imagem ou responda *PULAR*.')
        return
      }
      dados.foto_url = fotoUrl
      await db.salvarSessao(sk, 'cadastro_confirmar', dados)
      await enviarBotoes(celular,
        `Confira os dados:\n\n` +
        `👤 ${dados.nome}\n` +
        `🪪 ${dados.cpf}\n` +
        `🎂 ${formatarDataNasc(dados.data_nasc)}\n` +
        `📱 ${dados.celular_whatsapp}\n` +
        `🏢 ${dados.condominio_nome}\n` +
        `🏗️ ${dados.bloco} • 🚪 ${dados.unidade}\n` +
        `📸 ${fotoUrl ? 'Com foto' : 'Sem foto'}\n\n` +
        `Confirmar cadastro?`,
        [
          { id: 'admin_confirmar_sim', titulo: 'Confirmar' },
          { id: 'admin_confirmar_corrigir', titulo: 'Corrigir' },
        ]
      )
      break
    }

    case 'cadastro_confirmar': {
      if (buttonId === 'admin_confirmar_corrigir') {
        await db.salvarSessao(sk, 'cadastro_corrigir', dados)
        await enviarTexto(celular,
          'O que deseja corrigir?\n\n' +
          '1️⃣ Nome\n2️⃣ CPF\n3️⃣ Data de nascimento\n4️⃣ Celular\n5️⃣ Condomínio\n6️⃣ Bloco\n7️⃣ Unidade\n8️⃣ Foto\n\n_Digite o número_')
        return
      }
      if (buttonId === 'admin_confirmar_sim') {
        await finalizarCadastroAdmin(celular, dados, imagemBase64)
        return
      }
      await enviarBotoes(celular, 'Selecione uma opção:', [
        { id: 'admin_confirmar_sim', titulo: 'Confirmar' },
        { id: 'admin_confirmar_corrigir', titulo: 'Corrigir' },
      ])
      break
    }

    case 'cadastro_corrigir': {
      const mapa = { 1: 'cadastro_nome', 2: 'cadastro_cpf', 3: 'cadastro_nasc', 4: 'cadastro_celular', 5: 'cadastro_condominio', 6: 'cadastro_bloco', 7: 'cadastro_unidade', 8: 'cadastro_foto' }
      const destino = mapa[parseInt(texto)]
      if (!destino) {
        await enviarTexto(celular, 'Opção inválida. Digite de 1 a 8.')
        return
      }
      await db.salvarSessao(sk, destino, dados)
      const msgs = {
        cadastro_nome: 'Nome completo:',
        cadastro_cpf: 'CPF:',
        cadastro_nasc: 'Data de nascimento (DD/MM/AAAA):',
        cadastro_celular: 'Celular (com DDD):',
        cadastro_foto: '📸 Envie foto ou responda *PULAR*.',
        cadastro_unidade: 'Unidade/apartamento:',
      }
      if (destino === 'cadastro_condominio') {
        const condominios = await db.listarCondominios()
        const lista = condominios.map((c, i) => `${numEmoji(i + 1)} ${c.nome}`).join('\n')
        dados._condominios = condominios
        await db.salvarSessao(sk, destino, dados)
        await enviarTexto(celular, `Condomínio:\n\n${lista}\n\n_Digite o número_`)
      } else if (destino === 'cadastro_bloco') {
        const blocos = await db.listarBlocosPorCondominio(dados.condominio_id)
        if (blocos.length > 0) {
          const lista = blocos.map((b, i) => `${numEmoji(i + 1)} ${b.nome}`).join('\n')
          dados._blocos = blocos
          await db.salvarSessao(sk, destino, dados)
          await enviarTexto(celular, `Bloco:\n\n${lista}\n\n_Digite o número_`)
        } else {
          await enviarTexto(celular, 'Bloco do morador:')
        }
      } else {
        await enviarTexto(celular, msgs[destino] || 'Informe o novo valor:')
      }
      break
    }
  }
}

async function finalizarCadastroAdmin(celular, dados, imagemBase64) {
  const dataNascISO = dataParaISO(dados.data_nasc)

  const moradorCriado = await db.criarMorador({
    nome: dados.nome,
    cpf: dados.cpf,
    data_nasc: dataNascISO,
    celular_whatsapp: dados.celular_whatsapp,
    condominio_id: dados.condominio_id,
    bloco: dados.bloco,
    unidade: dados.unidade,
    foto_url: dados.foto_url || null,
    status: 'aprovado',
    aceite_tc: false,
    criado_em: new Date().toISOString(),
  })

  let syncOk = false
  if (dados.foto_url && dados.condominio_id) {
    try {
      const cond = await db.buscarCondominioPorNome(dados.condominio_nome)
      if (cond?.idface_ip) {
        const { cadastrarRostoIDFace, urlParaBase64 } = require('./idface')
        const fb64 = await urlParaBase64(dados.foto_url)
        await cadastrarRostoIDFace(cond.idface_ip, cond.idface_senha, moradorCriado, fb64, cond.idface_user || 'admin')
        syncOk = true
      }
    } catch(e) {
      console.error('Erro iDFace sync admin:', e.message)
      await enviarTexto(celular, `⚠️ Falha no sync iDFace: ${e.message}\nO morador foi cadastrado mas o reconhecimento facial não foi registrado.`)
    }
  }

  await db.deletarSessao(`admin_${celular}`)

  const fotoStatus = !dados.foto_url ? '⚠️ Sem foto — adicione pelo painel.'
    : syncOk ? '📷 Foto registrada + facial sincronizado.'
    : '📷 Foto registrada. ⚠️ Facial pendente.'
  await enviarTexto(celular,
    `✅ *${dados.nome}* cadastrado e aprovado!\n\n` +
    `📍 ${dados.bloco} • Apto ${dados.unidade} • ${dados.condominio_nome}\n` +
    `📱 ${dados.celular_whatsapp}\n` +
    fotoStatus
  )

  // Notifica o morador com T&C (aceite_tc = false até ele aceitar)
  try {
    await enviarBotoes(dados.celular_whatsapp,
      MSG.moradorTCNotificacao(dados.nome, dados.condominio_nome, config.LINK_TC),
      [
        { id: 'tc_morador_aceito', titulo: 'Li e estou de acordo' },
        { id: 'tc_morador_recusado', titulo: 'Não estou de acordo' },
      ]
    )
    await db.salvarSessao(dados.celular_whatsapp, 'morador_tc', { morador_id: moradorCriado.id })
  } catch(e) { console.warn('Não foi possível notificar o morador:', e.message) }

  await mostrarMenuPrincipal(celular)
}

module.exports = { handleAdmin, isAdmin, isComandoAdmin }
