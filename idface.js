// idface.js — integração com iDFace Pro via API REST
// Baseado na documentação oficial: controlid.com.br/docs/access-api-en/

// Detecta protocolo: URLs com domínio usam https, IPs locais usam http
function getProtocol(ip) {
  return (ip.includes('.com') || ip.includes('.net') || ip.includes('.org')) ? 'https' : 'http'
}

// Converte CPF para número inteiro (iDFace exige int64 no campo id)
function cpfParaInt(cpf) {
  if (!cpf) return 0
  return parseInt(String(cpf).replace(/\D/g, ''), 10)
}

// ─── LOGIN ────────────────────────────────────────────────────────
// POST /login.fcgi
async function loginIDFace(ip, senha, usuario = 'admin') {
  const proto = getProtocol(ip)
  const res = await fetch(`${proto}://${ip}/login.fcgi`, {
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
  const proto = getProtocol(ip)
  const session = await loginIDFace(ip, senha, usuario)
  const userId = cpfParaInt(morador.cpf)

  // 1. Verifica se usuário já existe
  const resCheck = await fetch(`${proto}://${ip}/load_objects.fcgi?session=${session}`, {
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
    const resUser = await fetch(`${proto}://${ip}/create_objects.fcgi?session=${session}`, {
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
    await fetch(`${proto}://${ip}/modify_objects.fcgi?session=${session}`, {
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
    `${proto}://${ip}/user_set_image.fcgi?user_id=${userId}&timestamp=${timestamp}&match=0&session=${session}`,
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
    await fetch(`${proto}://${ip}/create_objects.fcgi?session=${session}`, {
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
  const proto = getProtocol(ip)
  const session = await loginIDFace(ip, senha, usuario)
  const userId = cpfParaInt(moradorCpf)

  // 1. Remove foto via user_destroy_image.fcgi
  await fetch(`${proto}://${ip}/user_destroy_image.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  })

  // 2. Remove o usuário via destroy_objects
  const res = await fetch(`${proto}://${ip}/destroy_objects.fcgi?session=${session}`, {
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
  const proto = getProtocol(ip)
  const session = await loginIDFace(ip, senha, usuario)

  const res = await fetch(`${proto}://${ip}/execute_actions.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actions: [{ action: 'door', parameters: 'door=1' }],
    }),
  })
  if (!res.ok) throw new Error(`iDFace abrir porta falhou: ${res.status}`)
  return true
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
}
