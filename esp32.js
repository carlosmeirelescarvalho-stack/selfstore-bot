// esp32.js — aciona geladeira via comando enfileirado para o Raspberry Pi

const { getSupa } = require('./db')

// Salva um comando de abertura para a geladeira ser buscado via polling
async function abrirGeladeira(geladeiraId, moradorId) {
  const { error } = await getSupa().from('comandos_esp32').insert([{
    geladeira_id: geladeiraId,
    morador_id: moradorId,
    acao: 'abrir',
    status: 'pendente',
  }])
  if (error) throw error
  return true
}

module.exports = { abrirGeladeira }
