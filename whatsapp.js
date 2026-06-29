// services/whatsapp.js — envia mensagens via Meta Cloud API (WhatsApp oficial)

const config = require('./config')
const db = require('./db')

const GRAPH_URL = 'https://graph.facebook.com/v21.0'

async function enviarTexto(celular, texto) {
  const res = await fetch(`${GRAPH_URL}/${config.META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.META_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: celular,
      type: 'text',
      text: { body: texto },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp sendText error: ${err}`)
  }
  db.registrarMensagem(celular, 'enviada', texto, 'texto')
  return res.json()
}

// botoes = [{ id: 'btn_id', titulo: 'Texto do botao' }, ...] (max 3)
async function enviarBotoes(celular, corpo, botoes) {
  const res = await fetch(`${GRAPH_URL}/${config.META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.META_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: celular,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: corpo },
        action: {
          buttons: botoes.map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.titulo },
          })),
        },
      },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp sendButtons error: ${err}`)
  }
  const botoesTexto = botoes.map(b => b.titulo).join(' | ')
  db.registrarMensagem(celular, 'enviada', `${corpo}\n[${botoesTexto}]`, 'interativo')
  return res.json()
}

async function notificarAdmin(texto, condominioId) {
  const destinatarios = []

  if (condominioId) {
    const admins = await db.buscarAdminsPorCondominio(condominioId)
    destinatarios.push(...admins.map(a => a.celular))
  }

  // Fallback: ADMIN_CELULAR se nenhum admin vinculado
  if (destinatarios.length === 0 && config.ADMIN_CELULAR) {
    destinatarios.push(config.ADMIN_CELULAR)
  }

  for (const cel of [...new Set(destinatarios)]) {
    try {
      await enviarTexto(cel, `🔔 *Admin SelfStore*\n\n${texto}`)
    } catch(e) { console.error('Erro notif admin', cel, e.message) }
  }
}

function dentroHorarioComercial() {
  const agora = new Date()
  const hora = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })
  return parseInt(hora, 10) >= 9 && parseInt(hora, 10) < 18
}

async function iniciarAtendimentoHumano(celular, sessaoKey) {
  if (dentroHorarioComercial()) {
    await db.salvarSessao(sessaoKey || celular, 'atendimento_nome', {})
    await enviarTexto(celular, 'Para te encaminhar ao nosso time, preciso de algumas informações.\n\nQual é o seu *nome*?')
  } else {
    await enviarTexto(celular, 'Nosso atendimento humano funciona das 9h às 18h, mas já estou enviando seus dados para o time de suporte — eles entram em contato sempre que o dia se inicia.')
    await notificarAdmin(`📲 *Contato fora do horário*\n\nCelular: ${celular}\nHorário: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`)
  }
}

async function buscarImagemMeta(mediaId) {
  try {
    const resMeta = await fetch(`${GRAPH_URL}/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${config.META_ACCESS_TOKEN}` },
    })
    if (!resMeta.ok) return null
    const { url } = await resMeta.json()
    if (!url) return null
    const resImg = await fetch(url, {
      headers: { 'Authorization': `Bearer ${config.META_ACCESS_TOKEN}` },
    })
    if (!resImg.ok) return null
    const buffer = await resImg.arrayBuffer()
    return Buffer.from(buffer).toString('base64')
  } catch(e) {
    console.error('Erro ao buscar imagem Meta:', e.message)
    return null
  }
}

const MSG = {
  apresentacao: () =>
    'Olá, sou o bot de autoatendimento do Self Store Minimercados e vou listar aqui as formas de atendimento que tenho disponíveis',
  naoCadastrado: () =>
    'Vi que esse número de telefone que você está falando ainda não foi cadastrado, vamos fazer agora? Demora menos de 2 minutos',
  jaCadastrado: () =>
    'Vi que seu número já foi cadastrado na nossa base!\n\nPara abrir geladeiras, basta ler o QR Code que está colado na porta da própria geladeira!\n\nAgora, caso precise de algum outro apoio, posso te encaminhar para atendimento humano',
  naoEntendidoFluxo0: () =>
    'Me desculpe, não entendi.\n\nPara avançarmos, preciso que selecione uma das opções abaixo',
  sessaoAbandonada: () =>
    'Oi! Vi que começamos uma conversa ontem mas não finalizamos. Se quiser retomar, é só me mandar um oi :)',
  selecionarCondominio: (lista) =>
    `Em qual condomínio você mora?\n\n${lista}\n\n_Digite o número correspondente_`,
  condominioInvalido: () =>
    'Opção inválida. Por favor, escolha um número da lista.',
  termosCondicoes: (linkTC) =>
    `Ao seguir com o cadastro, você declara que está ciente e de acordo com nossos Termos e Condições.\n\n📄 ${linkTC}`,
  termosRecusados: () =>
    'Sem problemas, caso mude de ideia e queira aproveitar nossas ofertas, basta me chamar novamente',
  coletarNome: () =>
    '📝 Vamos começar! Qual é o seu *nome completo*?',
  nomeInvalido: () =>
    'Por favor, envie seu *nome e sobrenome* (mínimo duas palavras).\n\n_Ex: João Silva_',
  coletarCPF: () =>
    '🪪 Qual é o seu *CPF*?\n\n_Digite apenas os números ou no formato 000.000.000-00_',
  cpfInvalido: () =>
    '❌ CPF inválido. Por favor, verifique e envie novamente.\n\n_Ex: 123.456.789-09_',
  cpfJaCadastrado: () =>
    '❌ Este CPF já está cadastrado em nosso sistema.\n\nSe acredita que é um erro, entre em contato com o suporte respondendo *AJUDA*.',
  coletarDataNasc: () =>
    '🎂 Qual é a sua *data de nascimento*?\n\n_Digite no formato DD/MM/AAAA_\n_Ex: 15/05/1990_',
  dataNascInvalida: () =>
    '❌ Data inválida. Por favor, use o formato *DD/MM/AAAA*.\n_Ex: 15/05/1990_',
  coletarBloco: (lista) =>
    `🏗️ Em qual *bloco* você mora?\n\n${lista}\n\n_Digite o número correspondente_`,
  blocoInvalido: () =>
    'Opção inválida. Escolha um número da lista de blocos.',
  coletarUnidade: () =>
    '🚪 Qual é o número do seu *apartamento/unidade*?',
  unidadeInvalida: () =>
    'O apartamento precisa conter um número.',
  coletarFoto: () =>
    '📸 Agora envie uma *selfie* do seu rosto.\n\n✅ Rosto centralizado e visível\n✅ Boa iluminação\n✅ Sem óculos escuros ou máscara\n\n_Esta foto será usada para o reconhecimento facial na entrada do mercadinho._',
  fotoInvalida: () =>
    '❌ Não consegui identificar uma imagem. Por favor, envie uma *foto* (não documento, não vídeo).',
  confirmarDados: (nome, cpf, data, bloco, unidade, condominio) =>
    `Confira seus dados:\n\n👤 Nome: ${nome}\n🪪 CPF: ${cpf}\n🎂 Nascimento: ${data}\n🏗️ Bloco: ${bloco}\n🚪 Apto: ${unidade}\n🏢 Condomínio: ${condominio}\n\nEstá tudo certo?`,
  corrigirCampo: () =>
    'O que deseja corrigir?\n\n1️⃣ Nome\n2️⃣ CPF\n3️⃣ Data de nascimento\n4️⃣ Bloco\n5️⃣ Apartamento\n6️⃣ Foto\n\n_Digite o número_',
  cadastroAprovadoAuto: (nome) =>
    `🎉 *Cadastro aprovado, ${nome}!*\n\nSeu acesso ao Self Store está liberado.\n\nPara abrir a geladeira, aponte a câmera do celular para o *QR Code* colado na geladeira. 📷`,
  cadastroAprovadoSemFace: (nome) =>
    `Olá, *${nome}*! Estamos passando por instabilidades na rede e não conseguimos concluir o seu cadastro agora.\n\nPor favor, tente novamente mais tarde ou entre em contato com nosso suporte.`,
  cadastroEnviado: () =>
    '✅ *Cadastro enviado com sucesso!*\n\nSeu cadastro foi recebido e será analisado em breve.\n\nVocê receberá uma mensagem aqui quando for aprovado. 🎉',
  geladeiraNaoCadastrado: () =>
    '👋 Olá! Para abertura da geladeira é necessário realizar o cadastro, podemos fazer agora? Demora menos de 2 minutos!',
  acessoNegadoPendente: () =>
    '⏳ Seu cadastro ainda está *em análise*.\n\nVocê receberá uma mensagem assim que for aprovado.',
  acessoNegadoRejeitado: () =>
    '❌ Seu cadastro não foi aprovado.\n\nPara mais informações, entre em contato com a gente.',
  acessoBloqueado: () =>
    'Seu cadastro no Self Store Minimercado foi bloqueado e isso suspende o seu acesso.\n\nPara regularizar o acesso, entre em contato com nosso suporte.',
  acessoNegadoMenor: () =>
    '⛔ Acesso negado. Esta geladeira é restrita a *maiores de 18 anos*.',
  geladeiraAberta: (nomeGeladeira) =>
    `✅ *Tudo certo!* A *${nomeGeladeira}* está aberta.\n\nBom proveito! 🍻`,
  geladeiraEmManutencao: () =>
    '⚠️ Esta geladeira está em manutenção no momento. Tente novamente em alguns instantes.',
  geladeiraAceiteTCNecessario: (linkTC) =>
    `Para acessar a geladeira, é necessário aceitar nossos Termos e Condições.\n\n📄 ${linkTC}`,
  geladeiraAceiteTCRecusado: () =>
    'Sem o aceite não conseguimos liberar o acesso. Se tiver dúvidas, fale com o suporte Self Store.',
  moradorTCNotificacao: (nome, condominio, linkTC) =>
    `Olá, *${nome}*! Você foi cadastrado no Self Store *${condominio}* pelo administrador.\n\nPara utilizar o mercadinho, é necessário aceitar nossos Termos e Condições.\n\n📄 ${linkTC}`,
  moradorTCAceito: () =>
    '✅ Termos aceitos! Seu acesso está liberado.\n\nPara abrir a geladeira, aponte a câmera do celular para o *QR Code* colado na geladeira. 📷',
  erroGeral: () =>
    '⚠️ Ocorreu um erro inesperado. Tente novamente em alguns instantes.\n\nSe o problema persistir, envie *AJUDA*.',
  menuAjuda: () =>
    'Como posso te ajudar?',
  confirmarExclusao: () =>
    '⚠️ *Atenção: esta ação não pode ser desfeita.*\n\n' +
    'Ao excluir seus dados, seu acesso ao Self Store será cancelado permanentemente. Serão removidos:\n\n' +
    '• Seus dados pessoais (nome, CPF, data de nascimento)\n' +
    '• Sua foto e reconhecimento facial\n' +
    '• Seu histórico de cadastro\n\n' +
    'Deseja continuar?',
  exclusaoConcluida: () =>
    '✅ Seus dados foram excluídos com sucesso.\n\nSe quiser usar o Self Store novamente no futuro, será necessário um novo cadastro.',
  exclusaoCancelada: () =>
    'Ok, seus dados foram mantidos. Se precisar de algo mais, é só chamar!',
  exclusaoFalha: () =>
    'Tivemos uma falha técnica e não conseguimos completar a exclusão automática agora.\n\n' +
    'Mas não se preocupe, nosso time de suporte trabalhará na exclusão manual dos dados e enviará confirmação pra você assim que for concluído.\n\n' +
    'Nosso prazo máximo é de 72h e, nesse meio tempo, fique à vontade para falar com a gente.',
}

module.exports = { enviarTexto, enviarBotoes, notificarAdmin, iniciarAtendimentoHumano, dentroHorarioComercial, buscarImagemMeta, MSG }
