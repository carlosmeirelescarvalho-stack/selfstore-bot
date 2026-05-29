// services/whatsapp.js — envia mensagens via Evolution API

const config = require('./config')

const BASE = () => `${config.EVOLUTION_API_URL}/message`
const HEADERS = () => ({
  'Content-Type': 'application/json',
  apikey: config.EVOLUTION_API_KEY,
})
const INSTANCE = () => config.EVOLUTION_INSTANCE

// Envia mensagem de texto simples
async function enviarTexto(celular, texto) {
  const res = await fetch(`${BASE()}/sendText/${INSTANCE()}`, {
    method: 'POST',
    headers: HEADERS(),
    body: JSON.stringify({
      number: celular,
      text: texto,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp sendText error: ${err}`)
  }
  return res.json()
}

// Envia mensagem de texto para o admin
async function notificarAdmin(texto) {
  if (!config.ADMIN_CELULAR) return
  return enviarTexto(config.ADMIN_CELULAR, `🔔 *Admin SelfStore*\n\n${texto}`)
}

// Transfere para atendimento humano — envia aviso ao admin e ao morador
async function transferirParaHumano(celular, nomeMorador) {
  await enviarTexto(
    celular,
    `👤 *Atendimento humano*\n\nVou te conectar com o suporte. Um momento, por favor.\n\nEm breve alguém entrará em contato por aqui. 🙏`
  )
  await notificarAdmin(
    `📲 *Solicitação de ajuste de cadastro*\n\nMorador: ${nomeMorador || 'não identificado'}\nCelular: ${celular}\n\nAcesse o painel para ver o cadastro e responda neste chat.`
  )
}

// Mensagens prontas reutilizáveis
const MSG = {
  bemVindo: (nomeCondominio) =>
    `👋 Olá! Seja bem-vindo ao *Self Store ${nomeCondominio}*.\n\nComo posso te ajudar?\n\n1️⃣ Abrir geladeira\n2️⃣ Fazer cadastro`,

  jaCadastrado: (nome) =>
    `✅ Olá, *${nome}*! Você já possui cadastro ativo em nosso sistema.\n\nPrecisa fazer algum ajuste no seu cadastro?\n\n1️⃣ Sim, preciso ajustar\n2️⃣ Não, obrigado`,

  coletarNome: () =>
    `📝 Vamos começar seu cadastro!\n\nQual é o seu *nome completo*?`,

  coletarCPF: () =>
    `🪪 Qual é o seu *CPF*?\n\n_Digite apenas os números ou no formato 000.000.000-00_`,

  cpfInvalido: () =>
    `❌ CPF inválido. Por favor, verifique e envie novamente.\n\n_Ex: 123.456.789-09_`,

  cpfJaCadastrado: () =>
    `❌ Este CPF já está cadastrado em nosso sistema.\n\nSe acredita que é um erro, entre em contato com o suporte respondendo *AJUDA*.`,

  coletarDataNasc: () =>
    `🎂 Qual é a sua *data de nascimento*?\n\n_Digite no formato DD/MM/AAAA_\n_Ex: 15/05/1990_`,

  dataNascInvalida: () =>
    `❌ Data inválida. Por favor, use o formato *DD/MM/AAAA*.\n_Ex: 15/05/1990_`,

  menorDeIdade: () =>
    `⛔ Infelizmente o acesso ao Self Store é permitido apenas para *maiores de 18 anos*.\n\nQualquer dúvida, fale com a administração do condomínio.`,

  coletarTelefone: () =>
    `📱 Qual é o seu *telefone* (com DDD)?\n\n_Ex: 11 99999-9999_`,

  telefoneInvalido: () =>
    `❌ Telefone inválido. Envie com DDD.\n_Ex: 11 99999-9999_`,

  coletarCondominio: (lista) =>
    `🏢 Em qual condomínio você mora?\n\n${lista}\n\n_Digite o número correspondente_`,

  condominioInvalido: () =>
    `❌ Opção inválida. Por favor, escolha um número da lista.`,

  coletarBloco: () =>
    `🏗️ Qual é o seu *bloco*?\n\n_Ex: Bloco A, Torre 1_`,

  coletarUnidade: () =>
    `🚪 Qual é o número do seu *apartamento/unidade*?\n\n_Ex: 101, 203B_`,

  coletarFoto: () =>
    `📸 Agora envie uma *selfie* do seu rosto.\n\n✅ Rosto centralizado e visível\n✅ Boa iluminação\n✅ Sem óculos escuros ou máscara\n\n_Esta foto será usada para o reconhecimento facial na entrada do mercadinho._`,

  fotoInvalida: () =>
    `❌ Não consegui identificar uma imagem. Por favor, envie uma *foto* (não documento, não vídeo).`,

  cadastroEnviado: () =>
    `✅ *Cadastro enviado com sucesso!*\n\nSeu cadastro foi recebido e será analisado em breve.\n\nVocê receberá uma mensagem aqui quando for aprovado. 🎉`,

  cadastroAprovadoAuto: (nome) =>
    `🎉 *Cadastro aprovado, ${nome}!*\n\nSeu acesso ao Self Store está liberado.\n\nPara abrir a geladeira, aponte a câmera do celular para o *QR Code* colado na geladeira. 📷`,

  acessoNegadoPendente: () =>
    `⏳ Seu cadastro ainda está *em análise*.\n\nVocê receberá uma mensagem assim que for aprovado.`,

  acessoNegadoRejeitado: () =>
    `❌ Seu cadastro não foi aprovado.\n\nPara mais informações, entre em contato com a administração do condomínio.`,

  acessoNegadoMenor: () =>
    `⛔ Acesso negado. Esta geladeira é restrita a *maiores de 18 anos*.`,

  geladeiraAberta: (nomeGeladeira) =>
    `✅ *Tudo certo!* A *${nomeGeladeira}* está aberta.\n\n⏱️ Ela fecha automaticamente em *30 segundos*.\n\nBom proveito! 🍻`,

  erroGeral: () =>
    `⚠️ Ocorreu um erro inesperado. Tente novamente em alguns instantes.\n\nSe o problema persistir, envie *AJUDA*.`,

  naoEntendido: () =>
    `🤔 Não entendi sua mensagem.\n\nPara abrir uma geladeira, aponte a câmera para o *QR Code*.\nPara se cadastrar, envie *OI* ou *CADASTRO*.`,
}

module.exports = { enviarTexto, notificarAdmin, transferirParaHumano, MSG }
