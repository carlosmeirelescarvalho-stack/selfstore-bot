// services/idface.js — integração com iDFace Pro via API REST

// O iDFace usa autenticação por sessão (login → session token → usa nas chamadas)

async function loginIDFace(ip, senha) {
  const res = await fetch(`http://${ip}/login.fcgi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: senha }),
  })
  if (!res.ok) throw new Error(`iDFace login falhou: ${res.status}`)
  const data = await res.json()
  if (!data.session) throw new Error('iDFace não retornou session token')
  return data.session
}

// Cadastra usuário no iDFace com foto do rosto
// fotoBase64: imagem em base64 (sem o prefixo data:image/...)
async function cadastrarRostoIDFace(ip, senha, morador, fotoBase64) {
  const session = await loginIDFace(ip, senha)

  // 1. Cria o usuário
  const resUser = await fetch(`http://${ip}/create_objects.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'user',
      values: [{
        id: morador.id.toString(),
        name: morador.nome,
        registration: morador.cpf,
        // password deixamos vazio — acesso só por face
      }],
    }),
  })
  if (!resUser.ok) throw new Error(`iDFace criar usuário falhou: ${resUser.status}`)

  // 2. Vincula a foto (template facial)
  const resFace = await fetch(`http://${ip}/create_objects.fcgi?session=${session}`, {
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

// Remove usuário do iDFace (quando morador é rejeitado ou removido)
async function removerUsuarioIDFace(ip, senha, moradorId) {
  const session = await loginIDFace(ip, senha)

  const res = await fetch(`http://${ip}/destroy_objects.fcgi?session=${session}`, {
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

// Abre a porta remotamente via API (abertura de emergência ou teste)
async function abrirPortaIDFace(ip, senha) {
  const session = await loginIDFace(ip, senha)

  const res = await fetch(`http://${ip}/execute_actions.fcgi?session=${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actions: [{ action: 'door', parameters: 'door=1' }],
    }),
  })
  if (!res.ok) throw new Error(`iDFace abrir porta falhou: ${res.status}`)
  return true
}

// Converte URL pública de foto para base64 (para enviar ao iDFace)
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
