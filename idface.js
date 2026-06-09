// idface.js — integração com iDFace Pro via API REST

function getProtocol(ip) {
  return (ip.includes('.com') || ip.includes('.net') || ip.includes('.org')) ? 'https' : 'http'
}

// Converte CPF para número inteiro (iDFace exige int64)
// Remove pontos e traço e converte para número
function cpfParaInt(cpf) {
  if (!cpf) return 0
  return parseInt(cpf.replace(/\D/g, ''), 10)
}

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

async function cadastrarRostoIDFace(ip, senha, morador, fotoBase64, usuario = 'admin') {
  const proto = getProtocol(ip)
  const session = await loginIDFace(ip, senha, usuario)

  // 1. Verifica se usuário já existe
  const resCheck = await fetch(`${proto}://${ip}/load_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'users',
      where: [{ object: 'users', field: 'id', operator: '=', value: cpfParaInt(morador.cpf) }]
    }),
  })
  const checkData = await resCheck.json()
  const usuarioExiste = checkData?.users?.length > 0

  if (!usuarioExiste) {
    // 2a. Cria o usuário
    const resUser = await fetch(`${proto}://${ip}/create_objects.fcgi?session=${session}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'users',
        values: [{
          id: cpfParaInt(morador.cpf),
          name: morador.nome,
          registration: morador.cpf || '',
        }],
      }),
    })
    if (!resUser.ok) {
      const err = await resUser.text().catch(() => '')
      throw new Error(`iDFace criar usuário falhou: ${resUser.status} / ${err}`)
    }
  } else {
    // 2b. Atualiza o usuário existente
    const resUpd = await fetch(`${proto}://${ip}/modify_objects.fcgi?session=${session}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'users',
        values: { name: morador.nome },
        where: [{ object: 'users', field: 'id', operator: '=', value: cpfParaInt(morador.cpf) }]
      }),
    })
    if (!resUpd.ok) {
      const err = await resUpd.text().catch(() => '')
      throw new Error(`iDFace atualizar usuário falhou: ${resUpd.status} / ${err}`)
    }
  }

  // 3. Remove template facial anterior se existir
  await fetch(`${proto}://${ip}/destroy_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'face_templates',
      where: [{ object: 'face_templates', field: 'user_id', operator: '=', value: cpfParaInt(morador.cpf) }]
    }),
  })

  // 4. Cadastra novo template facial
  const resFace = await fetch(`${proto}://${ip}/create_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'face_templates',
      values: [{
        user_id: cpfParaInt(morador.cpf),
        face_image: fotoBase64,
      }],
    }),
  })
  if (!resFace.ok) {
    const err = await resFace.text().catch(() => '')
    throw new Error(`iDFace cadastrar face falhou: ${resFace.status} / ${err}`)
  }

  return true
}

async function removerUsuarioIDFace(ip, senha, moradorId, usuario = 'admin') {
  const proto = getProtocol(ip)
  const session = await loginIDFace(ip, senha, usuario)

  // Remove templates faciais primeiro
  await fetch(`${proto}://${ip}/destroy_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'face_templates',
      where: [{ object: 'face_templates', field: 'user_id', operator: '=', value: parseInt(String(moradorId).replace(/\D/g, ''), 10) }]
    }),
  })

  // Remove o usuário
  const res = await fetch(`${proto}://${ip}/destroy_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'users',
      where: [{ object: 'users', field: 'id', operator: '=', value: parseInt(String(moradorId).replace(/\D/g, ''), 10) }]
    }),
  })
  if (!res.ok) throw new Error(`iDFace remover usuário falhou: ${res.status}`)
  return true
}

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
