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

// Aceita DD/MM/AAAA ou DD/MM/AA (regra de seculo: AA <= 30 -> 2000, AA > 30 -> 1900)
function parseDataNascimento(dataNasc) {
  if (!dataNasc || typeof dataNasc !== 'string') return null
  const str = dataNasc.trim()

  // Formato DD/MM/AAAA
  const matchFull = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (matchFull) {
    const [, dia, mes, ano] = matchFull
    return new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia))
  }

  // Formato DD/MM/AA
  const matchShort = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/)
  if (matchShort) {
    const [, dia, mes, aa] = matchShort
    const aaNum = parseInt(aa)
    const ano = aaNum <= 30 ? 2000 + aaNum : 1900 + aaNum
    return new Date(ano, parseInt(mes) - 1, parseInt(dia))
  }

  // Formato ISO YYYY-MM-DD (vem do banco)
  const matchISO = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (matchISO) {
    const [, ano, mes, dia] = matchISO
    return new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia))
  }

  return null
}

function calcularIdade(dataNasc) {
  const nasc = typeof dataNasc === 'string' ? parseDataNascimento(dataNasc) : new Date(dataNasc)
  if (!nasc || isNaN(nasc.getTime())) return null
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
  const nasc = parseDataNascimento(dataNasc)
  if (!nasc || isNaN(nasc.getTime())) return { valida: false, motivo: 'Data inválida' }
  const idade = calcularIdade(dataNasc)
  if (idade < 0) return { valida: false, motivo: 'Data no futuro' }
  if (idade > 120) return { valida: false, motivo: 'Data muito antiga' }
  return { valida: true, idade }
}

function validarNomeCompleto(nome) {
  if (!nome || typeof nome !== 'string') return false
  const partes = nome.trim().split(/\s+/)
  return partes.length >= 2 && partes.every(p => p.length >= 1)
}

function validarUnidade(unidade) {
  if (!unidade || typeof unidade !== 'string') return false
  return /\d/.test(unidade.trim())
}

function validarTelefone(tel) {
  const limpo = tel.replace(/\D/g, '')
  return limpo.length >= 10 && limpo.length <= 13
}

function normalizarCelular(tel) {
  if (!tel) return null
  let digitos = String(tel).replace(/\D/g, '')
  if (digitos.startsWith('55') && digitos.length > 11) digitos = digitos.slice(2)
  if (digitos.startsWith('0') && digitos.length > 11) digitos = digitos.slice(1)
  if (digitos.length === 10) digitos = digitos.slice(0, 2) + '9' + digitos.slice(2)
  if (digitos.length !== 11) return null
  const resto = digitos.slice(2)
  if (!['9','8','7','6'].includes(resto[0])) return null
  return '55' + digitos
}

function formatarCelular(celular) {
  const limpo = String(celular).replace(/\D/g, '').replace(/^55/, '')
  if (limpo.length === 11) return `(${limpo.slice(0,2)}) ${limpo.slice(2,7)}-${limpo.slice(7)}`
  if (limpo.length === 10) return `(${limpo.slice(0,2)}) ${limpo.slice(2,6)}-${limpo.slice(6)}`
  return celular
}

// Normaliza data para formato DD/MM/AAAA (exibicao)
function formatarDataNasc(dataNasc) {
  const nasc = parseDataNascimento(dataNasc)
  if (!nasc) return dataNasc
  const d = String(nasc.getDate()).padStart(2, '0')
  const m = String(nasc.getMonth() + 1).padStart(2, '0')
  const a = nasc.getFullYear()
  return `${d}/${m}/${a}`
}

// Converte para ISO YYYY-MM-DD (banco)
function dataParaISO(dataNasc) {
  const nasc = parseDataNascimento(dataNasc)
  if (!nasc) return null
  const d = String(nasc.getDate()).padStart(2, '0')
  const m = String(nasc.getMonth() + 1).padStart(2, '0')
  return `${nasc.getFullYear()}-${m}-${d}`
}

module.exports = {
  validarCPF,
  formatarCPF,
  parseDataNascimento,
  calcularIdade,
  isMaiorDeIdade,
  validarDataNascimento,
  validarNomeCompleto,
  validarUnidade,
  validarTelefone,
  normalizarCelular,
  formatarCelular,
  formatarDataNasc,
  dataParaISO,
}
