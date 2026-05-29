// services/esp32.js — aciona geladeira via HTTP no ESP32

const config = require('./config')

// Envia comando de abertura para o ESP32 da geladeira
// O ESP32 expõe um endpoint simples: GET /abrir
async function abrirGeladeira(esp32Ip) {
  const url = `http://${esp32Ip}/abrir`

  const res = await fetch(url, {
    method: 'GET',
    // timeout de 5 segundos — se o ESP32 não responder, assumimos erro
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) throw new Error(`ESP32 respondeu com erro: ${res.status}`)
  return true
}

// Testa conectividade com o ESP32 (usado no painel admin)
async function testarConexaoESP32(esp32Ip) {
  try {
    const res = await fetch(`http://${esp32Ip}/status`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

module.exports = { abrirGeladeira, testarConexaoESP32 }
