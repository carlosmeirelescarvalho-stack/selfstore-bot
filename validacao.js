// validacao.js

const CPFS_BLOQUEADOS = [
  '12345678909', '01234567890', '10987654321',
  '00000000000', '11111111111', '22222222222', '33333333333',
  '44444444444', '55555555555', '66666666666', '77777777777',
  '88888888888', '99999999999',
]

function validarCPF(cpf) {
  const limpo = cpf.replace(/\D/g, '')
  if (limpo.length !== 11 || /^(\d)\1+$/.test(limpo)) return false
  if (CPFS_BLOQUEADOS.includes(limpo)) return false
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

// Regra de seculo para ano com 2 digitos: AA <= 30 -> 2000, AA > 30 -> 1900
function anoComSeculo(aa) {
  const aaNum = parseInt(aa)
  return aaNum <= 30 ? 2000 + aaNum : 1900 + aaNum
}

// Aceita, com ou sem separador: DD/MM/AAAA, DD/MM/AA, DDMMAAAA, DDMMAA,
// "DD MM AAAA"/"DD MM AA" (espacos) e ISO YYYY-MM-DD (do banco).
// A instrucao ao morador continua pedindo DD/MM/AAAA; formatos extras sao
// aceitos silenciosamente para reduzir friccao no teclado numerico do celular.
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
    return new Date(anoComSeculo(aa), parseInt(mes) - 1, parseInt(dia))
  }

  // Formato DDMMAAAA (8 digitos, sem separador) - ano literal
  const match8 = str.match(/^(\d{2})(\d{2})(\d{4})$/)
  if (match8) {
    const [, dia, mes, ano] = match8
    return new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia))
  }

  // Formato DDMMAA (6 digitos, sem separador) - regra de seculo
  const match6 = str.match(/^(\d{2})(\d{2})(\d{2})$/)
  if (match6) {
    const [, dia, mes, aa] = match6
    return new Date(anoComSeculo(aa), parseInt(mes) - 1, parseInt(dia))
  }

  // Formato com espacos: "DD MM AAAA" ou "DD MM AA"
  const matchEsp = str.match(/^(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})$/)
  if (matchEsp) {
    const [, dia, mes, anoRaw] = matchEsp
    const ano = anoRaw.length === 2 ? anoComSeculo(anoRaw) : parseInt(anoRaw)
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

const KEYCAPS = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣']
function numEmoji(n) {
  return n >= 1 && n <= 9 ? KEYCAPS[n] : `*${n}.*`
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
  numEmoji,
}
