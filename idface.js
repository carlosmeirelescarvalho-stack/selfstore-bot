// idface.js — integração com iDFace Pro via API REST
// Baseado na documentação oficial: controlid.com.br/docs/access-api-en/

// Retorna base URL do iDFace — aceita IP local, domínio ou URL completa
function getProtocol(ip) {
  return (ip.includes('.com') || ip.includes('.net') || ip.includes('.org')) ? 'https' : 'http'
}

function getBaseUrl(ip) {
  if (ip.startsWith('http://') || ip.startsWith('https://')) return ip.replace(/\/$/, '')
  return `${getProtocol(ip)}://${ip}`
}

// Converte CPF para número inteiro (iDFace exige int64 no campo id)
function cpfParaInt(cpf) {
  if (!cpf) return 0
  return parseInt(String(cpf).replace(/\D/g, ''), 10)
}

// ─── LOGIN ────────────────────────────────────────────────────────
// POST /login.fcgi
async function loginIDFace(ip, senha, usuario = 'admin') {
  const base = getBaseUrl(ip)
  const res = await fetch(`${base}/login.fcgi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: usuario, password: senha }),
  })
  if (!res.ok) throw new Error(`iDFace login falhou: ${res.status}`)
  const data = await res.json()
  if (!data.session) throw new Error('iDFace não retornou session token')
  return data.session
}

// ─── CADASTRAR ROSTO ──────────────────────────────────────────────
// Fluxo correto conforme documentação:
// 1. Cria usuário via create_objects (se não existir)
// 2. Envia foto via user_set_image.fcgi com Content-Type: application/octet-stream
async function cadastrarRostoIDFace(ip, senha, morador, fotoBase64, usuario = 'admin') {
  const base = getBaseUrl(ip)
  const session = await loginIDFace(ip, senha, usuario)
  const userId = cpfParaInt(morador.cpf)

  // 1. Verifica se usuário já existe
  const resCheck = await fetch(`${base}/load_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'users',
      where: [{ object: 'users', field: 'id', operator: '=', value: userId }]
    }),
  })
  const checkData = await resCheck.json()
  const usuarioExiste = checkData?.users?.length > 0

  if (!usuarioExiste) {
    // 2a. Cria o usuário (id como int64, registration e name como strings)
    const resUser = await fetch(`${base}/create_objects.fcgi?session=${session}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'users',
        values: [{
          id: userId,
          name: morador.nome,
          registration: String(morador.cpf || '').replace(/\D/g, ''),
        }],
      }),
    })
    if (!resUser.ok) {
      const err = await resUser.text().catch(() => '')
      throw new Error(`iDFace criar usuário falhou: ${resUser.status} / ${err}`)
    }
  } else {
    // 2b. Atualiza nome do usuário existente via modify_objects
    await fetch(`${base}/modify_objects.fcgi?session=${session}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'users',
        values: { name: morador.nome },
        where: [{ object: 'users', field: 'id', operator: '=', value: userId }]
      }),
    })
  }

  // 3. Envia foto via user_set_image.fcgi
  // Content-Type: application/octet-stream — foto como bytes binários
  // Parâmetros passados na query string: user_id, timestamp, match
  const fotoBuffer = Buffer.from(fotoBase64, 'base64')
  const timestamp = Math.floor(Date.now() / 1000)

  const resFoto = await fetch(
    `${base}/user_set_image.fcgi?user_id=${userId}&timestamp=${timestamp}&match=0&session=${session}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fotoBuffer,
    }
  )

  const fotoData = await resFoto.json().catch(() => ({}))
  console.log('iDFace user_set_image resposta:', JSON.stringify(fotoData))

  if (!resFoto.ok || fotoData.success === false) {
    const erros = fotoData.errors?.map(e => `[${e.code}] ${e.message}`).join(', ') || `HTTP ${resFoto.status}`
    const scores = fotoData.scores ? JSON.stringify(fotoData.scores) : 'N/A'
    throw new Error(`iDFace cadastrar foto falhou: ${erros} | scores: ${scores}`)
  }

  // 4. Vincula regra de acesso padrão (id=1 = sempre liberado)
  // Necessário para que o usuário tenha acesso autorizado pelo iDFace
  try {
    await fetch(`${base}/create_objects.fcgi?session=${session}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'user_access_rules',
        values: [{
          user_id: userId,
          access_rule_id: 1
        }],
      }),
    })
    console.log(`iDFace: regra de acesso vinculada para user_id ${userId}`)
  } catch(e) {
    console.warn('iDFace: aviso ao vincular regra de acesso:', e.message)
    // Não bloqueia — usuário foi cadastrado mesmo sem regra
  }

  console.log(`iDFace: rosto cadastrado com sucesso para user_id ${userId} (${morador.nome})`)
  return true
}

// ─── REMOVER USUÁRIO ──────────────────────────────────────────────
// Remove foto e depois o usuário
async function removerUsuarioIDFace(ip, senha, moradorCpf, usuario = 'admin') {
  const base = getBaseUrl(ip)
  const session = await loginIDFace(ip, senha, usuario)
  const userId = cpfParaInt(moradorCpf)

  // 1. Remove foto via user_destroy_image.fcgi
  await fetch(`${base}/user_destroy_image.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  })

  // 2. Remove o usuário via destroy_objects
  const res = await fetch(`${base}/destroy_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'users',
      where: [{ object: 'users', field: 'id', operator: '=', value: userId }]
    }),
  })
  if (!res.ok) throw new Error(`iDFace remover usuário falhou: ${res.status}`)
  return true
}

// ─── ABRIR PORTA ─────────────────────────────────────────────────
// POST /execute_actions.fcgi — action: 'door', parameters: 'door=1'
async function abrirPortaIDFace(ip, senha, usuario = 'admin') {
  const base = getBaseUrl(ip)
  const session = await loginIDFace(ip, senha, usuario)

  const res = await fetch(`${base}/execute_actions.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actions: [{ action: 'door', parameters: 'door=1' }],
    }),
  })
  if (!res.ok) throw new Error(`iDFace abrir porta falhou: ${res.status}`)
  return true
}

// ─── ALTERAR SENHA WEB ───────────────────────────────────────────
// POST /change_login.fcgi — troca usuário/senha de acesso web e API
async function alterarSenhaWebIDFace(ip, senhaAtual, novoLogin, novaSenha, usuario = 'admin') {
  const base = getBaseUrl(ip)
  const session = await loginIDFace(ip, senhaAtual, usuario)
  const res = await fetch(`${base}/change_login.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: novoLogin, password: novaSenha }),
  })
  if (!res.ok) throw new Error(`iDFace alterar senha falhou: ${res.status}`)
  return true
}

// ─── CADASTRAR ADMIN FÍSICO ──────────────────────────────────────
// Cria user_role com role=1 para exigir autenticação no menu do equipamento
async function cadastrarAdminFisicoIDFace(ip, senha, userId, usuario = 'admin', pin = null) {
  const base = getBaseUrl(ip)
  const session = await loginIDFace(ip, senha, usuario)

  const resCheck = await fetch(`${base}/load_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'user_roles',
      where: [{ object: 'user_roles', field: 'user_id', operator: '=', value: userId }]
    }),
  })
  const checkData = await resCheck.json()
  const jaEraAdmin = checkData?.user_roles?.length > 0

  if (!jaEraAdmin) {
    const res = await fetch(`${base}/create_objects.fcgi?session=${session}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'user_roles',
        values: [{ user_id: userId, role: 1 }],
      }),
    })
    if (!res.ok) throw new Error(`iDFace cadastrar admin falhou: ${res.status}`)
  }

  let pinMsg = ''
  if (pin) {
    await definirPinIDFaceComSessao(base, session, userId, pin)
    pinMsg = ' PIN de fallback cadastrado.'
  }

  const mensagem = (jaEraAdmin ? 'Usuário já era admin no equipamento.' : 'Admin cadastrado — menu do equipamento agora exige autenticação.') + pinMsg
  return { criado: !jaEraAdmin, mensagem }
}

// ─── PIN (fallback numérico para autenticação física) ────────────
async function definirPinIDFaceComSessao(base, session, userId, pin) {
  // Remove PIN existente do usuário (campo é único por user_id)
  await fetch(`${base}/destroy_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'pins',
      where: [{ object: 'pins', field: 'user_id', operator: '=', value: userId }]
    }),
  })

  const res = await fetch(`${base}/create_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'pins',
      values: [{ user_id: userId, value: String(pin) }],
    }),
  })
  if (!res.ok) throw new Error(`iDFace cadastrar PIN falhou: ${res.status}`)
  return true
}

async function definirPinIDFace(ip, senha, userId, pin, usuario = 'admin') {
  const base = getBaseUrl(ip)
  const session = await loginIDFace(ip, senha, usuario)
  return definirPinIDFaceComSessao(base, session, userId, pin)
}

// ─── DESATIVAR SSH ───────────────────────────────────────────────
async function desativarSSHIDFace(ip, senha, usuario = 'admin') {
  const base = getBaseUrl(ip)
  const session = await loginIDFace(ip, senha, usuario)
  const res = await fetch(`${base}/set_configuration.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ general: { ssh_enabled: '0' } }),
  })
  if (!res.ok) throw new Error(`iDFace desativar SSH falhou: ${res.status}`)
  return true
}

// ─── LISTAR ADMINS DO EQUIPAMENTO ────────────────────────────────
async function listarAdminsIDFace(ip, senha, usuario = 'admin') {
  const base = getBaseUrl(ip)
  const session = await loginIDFace(ip, senha, usuario)
  const res = await fetch(`${base}/load_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'user_roles' }),
  })
  if (!res.ok) throw new Error(`iDFace listar admins falhou: ${res.status}`)
  const data = await res.json()
  return data?.user_roles || []
}

// ─── URL PARA BASE64 ─────────────────────────────────────────────
async function urlParaBase64(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Erro ao buscar foto: ${res.status}`)
  const buffer = await res.arrayBuffer()
  return Buffer.from(buffer).toString('base64')
}

module.exports = {
  cadastrarRostoIDFace,
  removerUsuarioIDFace,
  abrirPortaIDFace,
  urlParaBase64,
  alterarSenhaWebIDFace,
  cadastrarAdminFisicoIDFace,
  definirPinIDFace,
  desativarSSHIDFace,
  listarAdminsIDFace,
  cpfParaInt,
}
