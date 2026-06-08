// validacao.js

function validarCPF(cpf) {
  const limpo = cpf.replace(/\D/g, '')
  if (limpo.length !== 11 || /^(\d)\1+$/.test(limpo)) return false
  let soma = 0, r
  for (let i = 0; i < 9; i++) soma += parseInt(limpo[i]) * (10 - i)
  r = 11 - (soma % 11); if (r >= 10) r = 0; if (r !== parseInt(limpo[9])) return false
  soma = 0
  for (let i = 0; i < 10; i++) soma += parseInt(limpo[i]) * (11 - i)
  r = 11 - (soma % 11); if (r >= 10) r = 0; return r === parseInt(limpo[10])
}

function formatarCPF(cpf) {
  const limpo = cpf.replace(/\D/g, '')
  return limpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
}

function calcularIdade(dataNasc) {
  let nasc
  if (typeof dataNasc === 'string' && dataNasc.includes('/')) {
    const [dia, mes, ano] = dataNasc.split('/')
    nasc = new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia))
  } else {
    nasc = new Date(dataNasc)
  }
  if (isNaN(nasc.getTime())) return null
  const hoje = new Date()
  let idade = hoje.getFullYear() - nasc.getFullYear()
  if (hoje < new Date(hoje.getFullYear(), nasc.getMonth(), nasc.getDate())) idade--
  return idade
}

function isMaiorDeIdade(dataNasc) {
  const idade = calcularIdade(dataNasc)
  if (idade === null) return false
  return idade >= 18
}

function validarDataNascimento(dataNasc) {
  const idade = calcularIdade(dataNasc)
  if (idade === null) return { valida: false, motivo: 'Data inválida' }
  if (idade < 0) return { valida: false, motivo: 'Data no futuro' }
  if (idade > 120) return { valida: false, motivo: 'Data muito antiga' }
  return { valida: true, idade }
}

function validarTelefone(tel) {
  const limpo = tel.replace(/\D/g, '')
  return limpo.length >= 10 && limpo.length <= 13
}

// ─── NORMALIZADOR DE CELULAR ROBUSTO ──────────────────────────────
// Regras brasileiras de telecom:
// - Remove tudo que não é número
// - Remove DDI 55 se já presente
// - Se sobrar 10 dígitos (DDD + 8 número): insere o 9 após DDD
// - Se sobrar 11 dígitos (DDD + 9 número): mantém
// - Adiciona 55 no início
// Resultado sempre: 55 + DDD(2) + 9 + número(8) = 13 dígitos

function normalizarCelular(tel) {
  if (!tel) return null

  // Remove tudo que não é dígito
  let digitos = String(tel).replace(/\D/g, '')

  // Remove DDI do Brasil se presente no início
  if (digitos.startsWith('55') && digitos.length > 11) {
    digitos = digitos.slice(2)
  }

  // Remove o 0 de discagem interurbana se presente
  if (digitos.startsWith('0') && digitos.length > 11) {
    digitos = digitos.slice(1)
  }

  // Agora deve ter 10 ou 11 dígitos
  if (digitos.length === 10) {
    // DDD (2) + número (8) — falta o 9
    // Insere o 9 após o DDD
    digitos = digitos.slice(0, 2) + '9' + digitos.slice(2)
  }

  // Valida: deve ter 11 dígitos agora
  if (digitos.length !== 11) return null

  // Garante que o 3º dígito é 9 (celular)
  // Se for 6, 7 ou 8, também insere o 9 (números muito antigos)
  const ddd = digitos.slice(0, 2)
  const resto = digitos.slice(2)
  if (!['9','8','7','6'].includes(resto[0])) return null

  // Normaliza: garante 9 como primeiro dígito do número
  let numero = resto
  if (numero.length === 8) {
    numero = '9' + numero
  }

  return '55' + ddd + numero
}

// Formata para exibição: (11) 99999-9999
function formatarCelular(celular) {
  const limpo = String(celular).replace(/\D/g, '').replace(/^55/, '')
  if (limpo.length === 11) {
    return `(${limpo.slice(0,2)}) ${limpo.slice(2,7)}-${limpo.slice(7)}`
  }
  if (limpo.length === 10) {
    return `(${limpo.slice(0,2)}) ${limpo.slice(2,6)}-${limpo.slice(6)}`
  }
  return celular
}

module.exports = {
  validarCPF,
  formatarCPF,
  calcularIdade,
  isMaiorDeIdade,
  validarDataNascimento,
  validarTelefone,
  normalizarCelular,
  formatarCelular,
}
