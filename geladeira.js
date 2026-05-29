// handlers/geladeira.js — fluxo 3 completo

const db = require('./db')
const { enviarTexto, MSG } = require('./whatsapp')
const { isMaiorDeIdade } = require('./validacao')
const { abrirGeladeira } = require('./esp32')
const config = require('./config')

// Mensagem enviada pelo QR Code: "ABRIR Geladeira 1 @Adele Zarzur"
// Detecta se a mensagem é um comando de abertura de geladeira
function isComandoGeladeira(mensagem) {
  return mensagem.trim().toUpperCase().startsWith('ABRIR ')
}

async function handleGeladeira(celular, mensagem) {
  try {
    // 1. Extrai o identificador da geladeira da mensagem
    // "ABRIR Geladeira 1 @Adele Zarzur" → "Geladeira 1 @Adele Zarzur"
    const codigoGeladeira = mensagem.trim().substring(6).trim()

    if (!codigoGeladeira) {
      await enviarTexto(celular, MSG.naoEntendido())
      return
    }

    // 2. Busca morador pelo celular
    const morador = await db.buscarMoradorPorCelular(celular)

    if (!morador) {
      // Não cadastrado — redireciona para cadastro
      await enviarTexto(
        celular,
        `👋 Olá! Para acessar a *${codigoGeladeira}*, você precisa estar cadastrado.\n\n` +
        `Para se cadastrar, aponte a câmera do celular para o *QR Code de cadastro* disponível no condomínio, ou envie *CADASTRO* agora.`
      )
      return
    }

    // 3. Verifica status do cadastro
    if (morador.status === 'pendente') {
      await enviarTexto(celular, MSG.acessoNegadoPendente())
      await db.registrarLog(morador.id, null, 'whatsapp', 'negado', 'cadastro pendente')
      return
    }

    if (morador.status === 'rejeitado') {
      await enviarTexto(celular, MSG.acessoNegadoRejeitado())
      await db.registrarLog(morador.id, null, 'whatsapp', 'negado', 'cadastro rejeitado')
      return
    }

    // 4. Busca a geladeira pelo código
    const geladeira = await db.buscarGeladeiraPorCodigo(codigoGeladeira)

    if (!geladeira) {
      await enviarTexto(
        celular,
        `❌ Geladeira não encontrada: *${codigoGeladeira}*.\n\nVerifique o QR Code e tente novamente.`
      )
      return
    }

    // 5. Verifica restrição de álcool
    if (geladeira.flag_alcoolica) {
      if (!isMaiorDeIdade(morador.data_nasc)) {
        await enviarTexto(celular, MSG.acessoNegadoMenor())
        await db.registrarLog(morador.id, geladeira.id, 'whatsapp', 'negado', 'menor de idade')
        return
      }
    }

    // 6. Verifica se o ESP32 está configurado
    if (!geladeira.esp32_ip) {
      await enviarTexto(
        celular,
        `⚠️ Esta geladeira ainda não está configurada. Informe o administrador.`
      )
      return
    }

    // 7. Aciona o ESP32
    await abrirGeladeira(geladeira.esp32_ip)

    // 8. Confirma para o morador
    await enviarTexto(celular, MSG.geladeiraAberta(geladeira.nome))

    // 9. Registra log
    await db.registrarLog(morador.id, geladeira.id, 'whatsapp', 'aberto', null)

  } catch (err) {
    console.error('Erro em handleGeladeira:', err)
    await enviarTexto(celular, MSG.erroGeral())
  }
}

module.exports = { handleGeladeira, isComandoGeladeira }
