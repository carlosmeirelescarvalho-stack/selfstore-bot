// handlers/importacao.js — importação em lote via Excel e cadastro manual

const XLSX = require('xlsx')
const db = require('./db')
const { validarCPF, validarDataNascimento, isMaiorDeIdade, validarTelefone, normalizarCelular } = require('./validacao')

// ─── PARSE DO EXCEL ───────────────────────────────
function parseExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
  return rows
}

// ─── NORMALIZA CABEÇALHOS ─────────────────────────
// Aceita variações: "Nome", "NOME", "nome completo" etc.
function normalizarChave(chave) {
  const mapa = {
    nome: ['nome', 'nome completo', 'name'],
    cpf: ['cpf', 'c.p.f', 'documento'],
    data_nasc: ['data_nasc', 'data de nascimento', 'nascimento', 'data nasc', 'datanasc'],
    telefone: ['telefone', 'celular', 'fone', 'phone', 'whatsapp'],
    bloco: ['bloco', 'torre', 'edificio', 'bloco/torre'],
    unidade: ['unidade', 'apto', 'apartamento', 'ap', 'apt'],
  }
  const normalizado = chave.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '')
  for (const [campo, aliases] of Object.entries(mapa)) {
    if (aliases.some(a => normalizado.includes(a))) return campo
  }
  return null
}

// ─── VALIDA UMA LINHA ─────────────────────────────
function validarLinha(linha, numero) {
  const erros = []
  const campos = {}

  for (const [chave, valor] of Object.entries(linha)) {
    const campo = normalizarChave(chave)
    if (campo) campos[campo] = String(valor).trim()
  }

  if (!campos.nome || campos.nome.length < 3) erros.push('Nome inválido ou ausente')
  if (!campos.cpf || !validarCPF(campos.cpf)) erros.push('CPF inválido')
  if (!campos.data_nasc) {
    erros.push('Data de nascimento ausente')
  } else {
    // Normaliza data — pode vir como objeto Date do Excel ou string
    let dataStr = campos.data_nasc
    if (linha[Object.keys(linha).find(k => normalizarChave(k) === 'data_nasc')] instanceof Date) {
      const d = linha[Object.keys(linha).find(k => normalizarChave(k) === 'data_nasc')]
      dataStr = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
      campos.data_nasc = dataStr
    }
    const v = validarDataNascimento(dataStr)
    if (!v.valida) erros.push(`Data inválida: ${dataStr}`)
    else if (!isMaiorDeIdade(dataStr)) erros.push('Menor de 18 anos')
  }
  if (!campos.bloco) erros.push('Bloco ausente')
  if (!campos.unidade) erros.push('Unidade ausente')

  return { numero, campos, erros, valida: erros.length === 0 }
}

// ─── PREVIEW DA PLANILHA ──────────────────────────
async function previewPlanilha(buffer, condominio_id) {
  const rows = parseExcel(buffer)
  if (rows.length === 0) return { erro: 'Planilha vazia ou sem dados' }
  if (rows.length > 500) return { erro: 'Planilha muito grande — máximo 500 linhas por importação' }

  const resultados = rows.map((row, i) => validarLinha(row, i + 2)) // linha 2 = depois do cabeçalho

  const validas = resultados.filter(r => r.valida).length
  const invalidas = resultados.filter(r => !r.valida).length

  return {
    total: rows.length,
    validas,
    invalidas,
    linhas: resultados.map(r => ({
      numero: r.numero,
      nome: r.campos.nome || '—',
      cpf: r.campos.cpf || '—',
      bloco: r.campos.bloco || '—',
      unidade: r.campos.unidade || '—',
      valida: r.valida,
      erros: r.erros,
    }))
  }
}

// ─── IMPORTAR PLANILHA ────────────────────────────
async function importarPlanilha(buffer, condominio_id) {
  const rows = parseExcel(buffer)
  const resultados = rows.map((row, i) => validarLinha(row, i + 2))
  const validas = resultados.filter(r => r.valida)

  const importados = []
  const erros = []

  for (const linha of validas) {
    try {
      const { campos } = linha
      const [dia, mes, ano] = campos.data_nasc.split('/')
      const dataNascISO = `${ano}-${mes.padStart(2,'0')}-${dia.padStart(2,'0')}`

      // Verifica CPF duplicado
      const existente = await db.buscarMoradorPorCPF(campos.cpf)
      if (existente) {
        erros.push({ nome: campos.nome, erro: 'CPF já cadastrado' })
        continue
      }

      const celular = campos.telefone ? normalizarCelular(campos.telefone) : null

      await db.criarMorador({
        nome: campos.nome,
        cpf: campos.cpf.replace(/\D/g, ''),
        data_nasc: dataNascISO,
        telefone: campos.telefone || null,
        celular_whatsapp: celular,
        condominio_id,
        bloco: campos.bloco,
        unidade: campos.unidade,
        foto_url: null,
        status: 'aprovado',
        criado_em: new Date().toISOString(),
      })
      importados.push(campos.nome)
    } catch (e) {
      erros.push({ nome: linha.campos.nome, erro: e.message })
    }
  }

  return { importados: importados.length, erros }
}

// ─── CADASTRO MANUAL (API) ────────────────────────
async function cadastrarManual(dados) {
  const erros = []
  if (!dados.nome || dados.nome.length < 3) erros.push('Nome inválido')
  if (!validarCPF(dados.cpf)) erros.push('CPF inválido')
  const v = validarDataNascimento(dados.data_nasc)
  if (!v.valida) erros.push('Data de nascimento inválida')
  else if (!isMaiorDeIdade(dados.data_nasc)) erros.push('Menor de 18 anos')
  if (!dados.condominio_id) erros.push('Condomínio obrigatório')
  if (!dados.bloco) erros.push('Bloco obrigatório')
  if (!dados.unidade) erros.push('Unidade obrigatória')

  if (erros.length > 0) return { erro: erros.join(', ') }

  const existente = await db.buscarMoradorPorCPF(dados.cpf)
  if (existente) return { erro: 'CPF já cadastrado' }

  const [dia, mes, ano] = dados.data_nasc.split('/')
  const dataNascISO = `${ano}-${mes.padStart(2,'0')}-${dia.padStart(2,'0')}`

  const morador = await db.criarMorador({
    nome: dados.nome,
    cpf: dados.cpf.replace(/\D/g, ''),
    data_nasc: dataNascISO,
    telefone: dados.telefone || null,
    celular_whatsapp: dados.celular ? normalizarCelular(dados.celular) : null,
    condominio_id: dados.condominio_id,
    bloco: dados.bloco,
    unidade: dados.unidade,
    foto_url: null,
    status: 'aprovado',
    criado_em: new Date().toISOString(),
  })

  return { morador }
}

module.exports = { previewPlanilha, importarPlanilha, cadastrarManual }
