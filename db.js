// services/db.js — todas as operações com o banco Supabase

const { createClient } = require('@supabase/supabase-js')
const config = require('./config')

// Inicialização lazy — só cria o cliente quando a primeira função for chamada
// Garante que as variáveis de ambiente já foram carregadas pelo Railway
let _supabase = null
function supabase() {
  if (!_supabase) {
    if (!config.SUPABASE_URL) throw new Error('SUPABASE_URL não definida nas variáveis de ambiente')
    _supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY)
  }
  return _supabase
}

// ─── MORADORES ────────────────────────────────────────────────────

async function buscarMoradorPorCelular(celular) {
  const { data, error } = await supabase()
    .from('moradores')
    .select('*, condominios(*)')
    .eq('celular_whatsapp', celular)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data
}

async function buscarMoradorPorCPF(cpf) {
  const limpo = cpf.replace(/\D/g, '')
  const { data, error } = await supabase()
    .from('moradores')
    .select('*')
    .eq('cpf', limpo)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data
}

async function criarMorador(dados) {
  const { data, error } = await supabase()
    .from('moradores')
    .insert([dados])
    .select()
    .single()
  if (error) throw error
  return data
}

async function atualizarStatusMorador(id, status) {
  const { data, error } = await supabase()
    .from('moradores')
    .update({ status, atualizado_em: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

async function atualizarFotoMorador(id, fotoUrl) {
  const { error } = await supabase()
    .from('moradores')
    .update({ foto_url: fotoUrl })
    .eq('id', id)
  if (error) throw error
}

// ─── SESSÕES DE CADASTRO ──────────────────────────────────────────
// Guardam o estado da conversa enquanto o morador está preenchendo dados

async function buscarSessao(celular) {
  const { data, error } = await supabase()
    .from('sessoes_cadastro')
    .select('*')
    .eq('celular', celular)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data
}

async function salvarSessao(celular, etapa, dados) {
  const payload = {
    celular,
    etapa_atual: etapa,
    dados_parciais: dados,
    atualizado_em: new Date().toISOString(),
  }
  const { error } = await supabase()
    .from('sessoes_cadastro')
    .upsert([payload], { onConflict: 'celular' })
  if (error) throw error
}

async function deletarSessao(celular) {
  const { error } = await supabase()
    .from('sessoes_cadastro')
    .delete()
    .eq('celular', celular)
  if (error) throw error
}

// ─── CONDOMÍNIOS ──────────────────────────────────────────────────

async function buscarCondominioPorNome(nome) {
  const { data, error } = await supabase()
    .from('condominios')
    .select('*')
    .ilike('nome', `%${nome}%`)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data
}

async function listarCondominios() {
  const { data, error } = await supabase()
    .from('condominios')
    .select('id, nome')
    .order('nome')
  if (error) throw error
  return data
}

// ─── GELADEIRAS ───────────────────────────────────────────────────

async function buscarGeladeiraPorCodigo(codigo) {
  // codigo = ex: "Geladeira 1 @Adele Zarzur"
  // extrai o condomínio do @ em diante
  const match = codigo.match(/@(.+)/)
  const nomeCondominio = match ? match[1].trim() : null
  const nomeGeladeira = codigo.split('@')[0].trim()

  let query = supabase()
    .from('geladeiras')
    .select('*, condominios(*)')
    .ilike('nome', `%${nomeGeladeira}%`)

  if (nomeCondominio) {
    // join via condominio
    const { data: cond } = await supabase()
      .from('condominios')
      .select('id')
      .ilike('nome', `%${nomeCondominio}%`)
      .single()
    if (cond) query = query.eq('condominio_id', cond.id)
  }

  const { data, error } = await query.single()
  if (error && error.code !== 'PGRST116') throw error
  return data
}

// ─── LOGS ─────────────────────────────────────────────────────────

async function registrarLog(moradorId, geladeiraId, tipo, resultado, detalhes) {
  const { error } = await supabase().from('logs_acesso').insert([{
    morador_id: moradorId,
    geladeira_id: geladeiraId,
    tipo,           // 'whatsapp' | 'facial'
    resultado,      // 'aberto' | 'negado'
    detalhes,       // ex: 'menor de idade', 'cadastro pendente'
    criado_em: new Date().toISOString(),
  }])
  if (error) throw error
}

// ─── UPLOAD DE FOTO ───────────────────────────────────────────────

async function uploadFoto(celular, buffer, mimetype) {
  const ext = mimetype.includes('png') ? 'png' : 'jpg'
  const path = `fotos/${celular}_${Date.now()}.${ext}`

  const { error } = await supabase().storage
    .from('selfstore')
    .upload(path, buffer, { contentType: mimetype, upsert: true })
  if (error) throw error

  const { data } = supabase().storage.from('selfstore').getPublicUrl(path)
  return data.publicUrl
}

module.exports = {
  buscarMoradorPorCelular,
  buscarMoradorPorCPF,
  criarMorador,
  atualizarStatusMorador,
  atualizarFotoMorador,
  buscarSessao,
  salvarSessao,
  deletarSessao,
  buscarCondominioPorNome,
  listarCondominios,
  buscarGeladeiraPorCodigo,
  registrarLog,
  uploadFoto,
}
