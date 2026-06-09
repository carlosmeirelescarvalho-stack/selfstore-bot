// idface.js — integração com iDFace Pro via API REST

// Detecta protocolo automaticamente
// URLs com domínio (.com, .net) usam https, IPs locais usam http
function getProtocol(ip) {
  return (ip.includes('.com') || ip.includes('.net') || ip.includes('.org')) ? 'https' : 'http'
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

  const resUser = await fetch(`${proto}://${ip}/create_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'user',
      values: [{
        id: morador.id.toString(),
        name: morador.nome,
        registration: morador.cpf,
      }],
    }),
  })
  if (!resUser.ok) {
    const errBody = await resUser.text().catch(() => '')
    // Se usuário já existe (400/409), tenta atualizar em vez de criar
    if (resUser.status === 400 || resUser.status === 409) {
      console.log(`Usuário já existe no iDFace, atualizando... (${errBody})`)
      const resUpd = await fetch(`${proto}://${ip}/set_object_properties.fcgi?session=${session}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          object: 'user',
          where: { id: morador.id.toString() },
          values: { name: morador.nome },
        }),
      })
      if (!resUpd.ok) {
        const updErr = await resUpd.text().catch(() => '')
        throw new Error(`iDFace criar/atualizar usuário falhou: ${resUser.status} / ${updErr}`)
      }
    } else {
      throw new Error(`iDFace criar usuário falhou: ${resUser.status} / ${errBody}`)
    }
  }

  const resFace = await fetch(`${proto}://${ip}/create_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'face_template',
      values: [{
        user_id: morador.id.toString(),
        face_image: fotoBase64,
      }],
    }),
  })
  if (!resFace.ok) throw new Error(`iDFace cadastrar face falhou: ${resFace.status}`)

  return true
}

async function removerUsuarioIDFace(ip, senha, moradorId, usuario = 'admin') {
  const proto = getProtocol(ip)
  const session = await loginIDFace(ip, senha, usuario)

  const res = await fetch(`${proto}://${ip}/destroy_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'user',
      where: { id: moradorId.toString() },
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
