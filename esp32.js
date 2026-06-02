// esp32.js — aciona geladeira via HTTP no ESP32

const config = require('./config')

// Chave secreta compartilhada com o ESP32
const ESP32_SECRET = process.env.ESP32_SECRET || 'troque-por-uma-chave-secreta-forte'

// Envia comando de abertura para o ESP32 da geladeira
async function abrirGeladeira(esp32Ip) {
  const url = `http://${esp32Ip}/abrir`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-ESP32-Secret': ESP32_SECRET,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) throw new Error(`ESP32 respondeu com erro: ${res.status}`)
  return true
}

// Fecha a geladeira manualmente (admin)
async function fecharGeladeira(esp32Ip) {
  const res = await fetch(`http://${esp32Ip}/fechar`, {
    method: 'POST',
    headers: { 'X-ESP32-Secret': ESP32_SECRET },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`ESP32 fechar erro: ${res.status}`)
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

module.exports = { abrirGeladeira, fecharGeladeira, testarConexaoESP32 }
