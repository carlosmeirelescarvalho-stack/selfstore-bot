// esp32.js — gerencia comandos para o Raspberry Pi via polling (v23)
//
// O servidor roda na nuvem (Railway) e o Raspberry Pi está em rede local,
// então não é possível chamar o Pi diretamente. Em vez disso, o comando é
// salvo na tabela `comandos_esp32` e o Pi busca via polling (GET /esp32/comandos)
// a cada poucos segundos, executando o relé e confirmando via ACK.

const config = require('./config')
const db = require('./db')

// Chave secreta compartilhada com o Raspberry Pi
const ESP32_SECRET = config.ESP32_SECRET

// Cria um comando pendente de abertura para a geladeira
async function abrirGeladeira(geladeiraId, moradorId) {
  await db.criarComandoEsp32(geladeiraId, 'abrir', moradorId)
  return true
}

// Cria um comando pendente de fechamento (uso manual via admin)
async function fecharGeladeira(geladeiraId, moradorId) {
  await db.criarComandoEsp32(geladeiraId, 'fechar', moradorId)
  return true
}

module.exports = { abrirGeladeira, fecharGeladeira, ESP32_SECRET }
