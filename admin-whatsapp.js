// admin-whatsapp.js — menu admin via WhatsApp

const db = require('./db')
const { enviarTexto, MSG } = require('./whatsapp')
const { validarCPF, validarDataNascimento, isMaiorDeIdade, validarTelefone, normalizarCelular } = require('./validacao')
const { cadastrarRostoIDFace, urlParaBase64 } = require('./idface')

// ─── VERIFICA SE NÚMERO É ADMIN ───────────────────
async function isAdmin(celular) {
  const admins = await db.listarAdmins()
  return admins.some(a => a.celular === celular && a.ativo)
}

// ─── DETECTA SE MENSAGEM É COMANDO ADMIN ──────────
// Admin só entra no menu admin digitando ADMIN ou MENU ADMIN
// Fora isso, funciona como morador normal (abre geladeira, cadastra, etc.)
function isComandoAdmin(texto) {
  const t = texto.trim().toUpperCase()
  return t === 'ADMIN' || t === 'MENU ADMIN' || t === 'ADM'
}

// ─── HANDLER PRINCIPAL ────────────────────────────
async function handleAdmin(celular, mensagem, tipoMensagem, imagemBase64) {
  try {
    const sessao = await db.buscarSessao(`admin_${celular}`)
    const texto = mensagem.trim()

    // Sem sessão admin ativa — só entra no menu se digitar ADMIN
    if (!sessao) {
      if (isComandoAdmin(texto)) {
        await mostrarMenuPrincipal(celular)
      }
      // Se não for comando admin, retorna false para o roteamento principal continuar
      return !isComandoAdmin(texto) ? 'continuar' : 'ok'
    }

    const etapa = sessao.etapa_atual
    const dados = sessao.dados_parciais || {}

    // Permite sair do menu admin a qualquer momento
    if (texto.toUpperCase() === 'SAIR' || texto === '0') {
      await encerrarSessaoAdmin(celular)
      return 'ok'
    }

    // ── MENU PRINCIPAL ──
    if (etapa === 'menu') {
      switch (texto) {
        case '1': await listarPendentes(celular); break
        case '2': await iniciarAprovacao(celular); break
        case '3': await iniciarRejeicao(celular); break
        case '4': await iniciarBloqueio(celular); break
        case '5': await iniciarCadastroAdmin(celular); break
        default:
          await enviarTexto(celular, `Opção inválida. Responda com um número de 1 a 5 ou *0* para sair.`)
          await mostrarMenuPrincipal(celular)
      }
      return 'ok'
    }

    // ── APROVAÇÃO ──
    if (etapa === 'aprovar_busca') { await buscarMoradorParaAprovar(celular, texto); return 'ok' }
    if (etapa === 'aprovar_confirmar') { await confirmarAprovacao(celular, texto, dados); return 'ok' }

    // ── REJEIÇÃO ──
    if (etapa === 'rejeitar_busca') { await buscarMoradorParaRejeitar(celular, texto); return 'ok' }
    if (etapa === 'rejeitar_confirmar') { await confirmarRejeicao(celular, texto, dados); return 'ok' }

    // ── BLOQUEIO ──
    if (etapa === 'bloquear_busca') { await buscarMoradorParaBloquear(celular, texto); return 'ok' }
    if (etapa === 'bloquear_confirmar') { await confirmarBloqueio(celular, texto, dados); return 'ok' }

    // ── CADASTRO MANUAL ──
    if (etapa.startsWith('cadastro_')) {
      await processarCadastroAdmin(celular, texto, tipoMensagem, imagemBase64, sessao)
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
    `1️⃣ Ver pendentes${pendentes > 0 ? ` *(${pendentes} aguardando)*` : ''}\n` +
    `2️⃣ Aprovar morador\n` +
    `3️⃣ Rejeitar morador\n` +
    `4️⃣ Bloquear morador\n` +
    `5️⃣ Cadastrar morador\n` +
    `0️⃣ Sair do menu admin\n\n` +
    `_Responda com o número da opção_`
  )
}

async function encerrarSessaoAdmin(celular) {
  await db.deletarSessao(`admin_${celular}`)
  await enviarTexto(celular, `✅ Menu admin encerrado. Você continua com acesso normal ao mercadinho.`)
}

// ─── LISTAR PENDENTES ─────────────────────────────
async function listarPendentes(celular) {
  const pendentes = await db.listarMoradoresPorStatus('pendente')
  if (pendentes.length === 0) {
    await enviarTexto(celular, `✅ Nenhum cadastro pendente no momento.`)
    await mostrarMenuPrincipal(celular)
    return
  }
  const lista = pendentes.slice(0, 10).map((m, i) =>
    `${i + 1}. *${m.nome}*\n   ${m.bloco} • Apto ${m.unidade} • ${m.condominios?.nome || ''}`
  ).join('\n\n')
  await enviarTexto(celular,
    `⏳ *Cadastros pendentes:*\n\n${lista}\n\n` +
    `Use a opção *2* para aprovar ou *3* para rejeitar.`
  )
  await mostrarMenuPrincipal(celular)
}

// ─── APROVAÇÃO ────────────────────────────────────
async function iniciarAprovacao(celular) {
  await db.salvarSessao(`admin_${celular}`, 'aprovar_busca', {})
  await enviarTexto(celular, `Digite o *celular* ou *nome* do morador que deseja aprovar:`)
}

async function buscarMoradorParaAprovar(celular, busca) {
  const morador = await db.buscarMoradorParaAcao(busca)
  if (!morador) {
    await enviarTexto(celular, `❌ Morador não encontrado. Tente com outro nome ou celular.`)
    return
  }
  await db.salvarSessao(`admin_${celular}`, 'aprovar_confirmar', {
    morador_id: morador.id,
    morador_nome: morador.nome,
    morador_celular: morador.celular_whatsapp,
    foto_url: morador.foto_url,
    condominio: morador.condominios
  })
  await enviarTexto(celular,
    `Confirma aprovação de *${morador.nome}*?\n` +
    `${morador.bloco} • Apto ${morador.unidade}\n\n` +
    `Responda *SIM* para confirmar ou *NÃO* para cancelar.`
  )
}

async function confirmarAprovacao(celular, resposta, dados) {
  if (resposta.toUpperCase() === 'SIM') {
    await db.atualizarStatusMorador(dados.morador_id, 'aprovado')
    if (dados.morador_celular) {
      await enviarTexto(dados.morador_celular, MSG.cadastroAprovadoAuto(dados.morador_nome))
    }
    if (dados.foto_url && dados.condominio?.idface_ip) {
      try {
        const fotoBase64 = await urlParaBase64(dados.foto_url)
        await cadastrarRostoIDFace(dados.condominio.idface_ip, dados.condominio.idface_senha,
          { id: dados.morador_id, nome: dados.morador_nome, cpf: '' }, fotoBase64)
      } catch (e) { console.error('Erro iDFace:', e) }
    }
    await enviarTexto(celular, `✅ *${dados.morador_nome}* aprovado!`)
  } else {
    await enviarTexto(celular, `Aprovação cancelada.`)
  }
  await mostrarMenuPrincipal(celular)
}

// ─── REJEIÇÃO ─────────────────────────────────────
async function iniciarRejeicao(celular) {
  await db.salvarSessao(`admin_${celular}`, 'rejeitar_busca', {})
  await enviarTexto(celular, `Digite o *celular* ou *nome* do morador que deseja rejeitar:`)
}

async function buscarMoradorParaRejeitar(celular, busca) {
  const morador = await db.buscarMoradorParaAcao(busca)
  if (!morador) { await enviarTexto(celular, `❌ Morador não encontrado.`); return }
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
    await enviarTexto(celular, `Cancelado.`)
  }
  await mostrarMenuPrincipal(celular)
}

// ─── BLOQUEIO ─────────────────────────────────────
async function iniciarBloqueio(celular) {
  await db.salvarSessao(`admin_${celular}`, 'bloquear_busca', {})
  await enviarTexto(celular, `Digite o *celular* ou *nome* do morador que deseja bloquear:`)
}

async function buscarMoradorParaBloquear(celular, busca) {
  const morador = await db.buscarMoradorParaAcao(busca)
  if (!morador) { await enviarTexto(celular, `❌ Morador não encontrado.`); return }
  await db.salvarSessao(`admin_${celular}`, 'bloquear_confirmar',
    { morador_id: morador.id, morador_nome: morador.nome, morador_celular: morador.celular_whatsapp })
  await enviarTexto(celular,
    `Confirma *bloqueio* de *${morador.nome}*?\n` +
    `O acesso será suspenso imediatamente.\n\nResponda *SIM* ou *NÃO*.`)
}

async function confirmarBloqueio(celular, resposta, dados) {
  if (resposta.toUpperCase() === 'SIM') {
    await db.atualizarStatusMorador(dados.morador_id, 'rejeitado')
    if (dados.morador_celular) {
      await enviarTexto(dados.morador_celular,
        `⛔ Seu acesso ao Self Store foi *suspenso* pelo administrador.\n\nPara mais informações, entre em contato com a administração do condomínio.`)
    }
    await enviarTexto(celular, `✅ *${dados.morador_nome}* bloqueado.`)
  } else {
    await enviarTexto(celular, `Cancelado.`)
  }
  await mostrarMenuPrincipal(celular)
}

// ─── CADASTRO MANUAL PELO ADMIN ───────────────────
async function iniciarCadastroAdmin(celular) {
  await db.salvarSessao(`admin_${celular}`, 'cadastro_nome', {})
  await enviarTexto(celular,
    `📝 *Cadastro de morador*\n\n` +
    `Qual é o *nome completo* do morador?\n\n` +
    `_Responda SAIR a qualquer momento para cancelar_`)
}

async function processarCadastroAdmin(celular, texto, tipoMensagem, imagemBase64, sessao) {
  const etapa = sessao.etapa_atual
  const dados = sessao.dados_parciais || {}

  if (etapa === 'cadastro_nome') {
    if (texto.length < 3) { await enviarTexto(celular, `Nome muito curto. Tente novamente.`); return }
    dados.nome = texto
    await db.salvarSessao(`admin_${celular}`, 'cadastro_cpf', dados)
    await enviarTexto(celular, `CPF do morador:`)
    return
  }

  if (etapa === 'cadastro_cpf') {
    if (!validarCPF(texto)) { await enviarTexto(celular, `CPF inválido. Tente novamente.`); return }
    const existente = await db.buscarMoradorPorCPF(texto)
    if (existente) { await enviarTexto(celular, `❌ CPF já cadastrado no sistema.`); return }
    dados.cpf = texto.replace(/\D/g, '')
    await db.salvarSessao(`admin_${celular}`, 'cadastro_nasc', dados)
    await enviarTexto(celular, `Data de nascimento (DD/MM/AAAA):`)
    return
  }

  if (etapa === 'cadastro_nasc') {
    const v = validarDataNascimento(texto)
    if (!v.valida) { await enviarTexto(celular, `Data inválida. Use o formato DD/MM/AAAA.`); return }
    if (!isMaiorDeIdade(texto)) {
      await enviarTexto(celular, `❌ Menor de 18 anos não pode ser cadastrado.`)
      await mostrarMenuPrincipal(celular)
      return
    }
    dados.data_nasc = texto
    await db.salvarSessao(`admin_${celular}`, 'cadastro_celular', dados)
    await enviarTexto(celular,
      `Celular do morador (com DDD):\n\n` +
      `_Ex: 11 99999-9999 ou 11 9999-9999 (sem o 9)_`)
    return
  }

  if (etapa === 'cadastro_celular') {
    const celularNorm = normalizarCelular(texto)
    if (!celularNorm) { await enviarTexto(celular, `Celular inválido. Informe com DDD.`); return }
    dados.celular_whatsapp = celularNorm
    dados.telefone = texto.replace(/\D/g, '')

    const condominios = await db.listarCondominios()
    const lista = condominios.map((c, i) => `${i + 1}️⃣ ${c.nome}`).join('\n')
    dados._condominios = condominios
    await db.salvarSessao(`admin_${celular}`, 'cadastro_condominio', dados)
    await enviarTexto(celular, `Condomínio:\n\n${lista}\n\n_Responda com o número_`)
    return
  }

  if (etapa === 'cadastro_condominio') {
    const condominios = dados._condominios || []
    const idx = parseInt(texto) - 1
    if (isNaN(idx) || idx < 0 || idx >= condominios.length) {
      await enviarTexto(celular, `Opção inválida. Escolha um número da lista.`); return
    }
    dados.condominio_id = condominios[idx].id
    dados.condominio_nome = condominios[idx].nome
    delete dados._condominios
    await db.salvarSessao(`admin_${celular}`, 'cadastro_bloco', dados)
    await enviarTexto(celular, `Bloco do morador:\n\n_Ex: Bloco A, Torre 1_`)
    return
  }

  if (etapa === 'cadastro_bloco') {
    dados.bloco = texto
    await db.salvarSessao(`admin_${celular}`, 'cadastro_unidade', dados)
    await enviarTexto(celular, `Unidade/apartamento:\n\n_Ex: 101, 203B_`)
    return
  }

  if (etapa === 'cadastro_unidade') {
    dados.unidade = texto
    await db.salvarSessao(`admin_${celular}`, 'cadastro_foto', dados)
    await enviarTexto(celular,
      `📸 Envie uma *foto do rosto* do morador.\n\n` +
      `Se não tiver agora, responda *PULAR* — a foto pode ser adicionada depois pelo painel.`)
    return
  }

  if (etapa === 'cadastro_foto') {
    let fotoUrl = null
    if (tipoMensagem === 'image' && imagemBase64) {
      const buffer = Buffer.from(imagemBase64, 'base64')
      fotoUrl = await db.uploadFoto(dados.celular_whatsapp || celular, buffer, 'image/jpeg')
    } else if (texto.toUpperCase() !== 'PULAR') {
      await enviarTexto(celular, `Envie uma imagem ou responda *PULAR* para pular.`)
      return
    }

    // Converte data DD/MM/YYYY para YYYY-MM-DD
    const [dia, mes, ano] = dados.data_nasc.split('/')
    const dataNascISO = `${ano}-${mes.padStart(2,'0')}-${dia.padStart(2,'0')}`

    await db.criarMorador({
      nome: dados.nome,
      cpf: dados.cpf,
      data_nasc: dataNascISO,
      telefone: dados.telefone || null,
      celular_whatsapp: dados.celular_whatsapp,
      condominio_id: dados.condominio_id,
      bloco: dados.bloco,
      unidade: dados.unidade,
      foto_url: fotoUrl,
      status: 'aprovado',
      criado_em: new Date().toISOString(),
    })

    await db.deletarSessao(`admin_${celular}`)

    await enviarTexto(celular,
      `✅ *${dados.nome}* cadastrado e aprovado!\n\n` +
      `📍 ${dados.bloco} • Apto ${dados.unidade} • ${dados.condominio_nome}\n` +
      `📱 ${dados.celular_whatsapp}\n` +
      `${fotoUrl ? '📷 Foto registrada.' : '⚠️ Sem foto — adicione pelo painel.'}`
    )

    // Notifica o morador pelo WhatsApp
    try {
      await enviarTexto(dados.celular_whatsapp, MSG.cadastroAprovadoAuto(dados.nome))
    } catch(e) { console.warn('Não foi possível notificar o morador:', e.message) }

    await mostrarMenuPrincipal(celular)
  }
}

module.exports = { handleAdmin, isAdmin, isComandoAdmin }
