// services/validacao.js

// Valida CPF pelo algoritmo oficial dos dois dígitos verificadores
function validarCPF(cpf) {
  const limpo = cpf.replace(/\D/g, '')

  if (limpo.length !== 11) return false
  // Rejeita sequências inválidas como 111.111.111-11
  if (/^(\d)\1+$/.test(limpo)) return false

  let soma = 0
  for (let i = 0; i < 9; i++) soma += parseInt(limpo[i]) * (10 - i)
  let resto = 11 - (soma % 11)
  const dig1 = resto >= 10 ? 0 : resto
  if (dig1 !== parseInt(limpo[9])) return false

  soma = 0
  for (let i = 0; i < 10; i++) soma += parseInt(limpo[i]) * (11 - i)
  resto = 11 - (soma % 11)
  const dig2 = resto >= 10 ? 0 : resto
  return dig2 === parseInt(limpo[10])
}

// Formata CPF para exibição: 000.000.000-00
function formatarCPF(cpf) {
  const limpo = cpf.replace(/\D/g, '')
  return limpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
}

// Calcula idade exata a partir da data de nascimento
// Aceita formato YYYY-MM-DD ou DD/MM/YYYY
function calcularIdade(dataNasc) {
  let nasc

  if (dataNasc.includes('/')) {
    // DD/MM/YYYY → converte para Date
    const [dia, mes, ano] = dataNasc.split('/')
    nasc = new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia))
  } else {
    nasc = new Date(dataNasc)
  }

  if (isNaN(nasc.getTime())) return null

  const hoje = new Date()
  let idade = hoje.getFullYear() - nasc.getFullYear()
  const aindaNaoFezAniversario =
    hoje < new Date(hoje.getFullYear(), nasc.getMonth(), nasc.getDate())
  if (aindaNaoFezAniversario) idade--

  return idade
}

function isMaiorDeIdade(dataNasc) {
  const idade = calcularIdade(dataNasc)
  if (idade === null) return false
  return idade >= 18
}

// Valida se a data de nascimento faz sentido (não é futura, não é absurda)
function validarDataNascimento(dataNasc) {
  const idade = calcularIdade(dataNasc)
  if (idade === null) return { valida: false, motivo: 'Data inválida' }
  if (idade < 0) return { valida: false, motivo: 'Data no futuro' }
  if (idade > 120) return { valida: false, motivo: 'Data muito antiga' }
  return { valida: true, idade }
}

// Valida telefone brasileiro (com ou sem DDD, com ou sem 9)
function validarTelefone(tel) {
  const limpo = tel.replace(/\D/g, '')
  return limpo.length === 10 || limpo.length === 11
}

// Normaliza telefone para o formato do WhatsApp: 55DDDNUMERO
function normalizarCelular(tel) {
  const limpo = tel.replace(/\D/g, '')
  if (limpo.startsWith('55') && limpo.length >= 12) return limpo
  return '55' + limpo
}

module.exports = {
  validarCPF,
  formatarCPF,
  calcularIdade,
  isMaiorDeIdade,
  validarDataNascimento,
  validarTelefone,
  normalizarCelular,
}
