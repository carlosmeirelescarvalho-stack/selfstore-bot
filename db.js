// services/db.js — todas as operações com o banco Supabase

const { createClient } = require('@supabase/supabase-js')
const ws = require('ws')
const config = require('./config')

let _supabase = null
function supabase() {
  if (!_supabase) {
    if (!config.SUPABASE_URL) throw new Error('SUPABASE_URL nao definida')
    _supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
      realtime: { transport: ws }
    })
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

async function atualizarAceiteTCMorador(id) {
  const { error } = await supabase()
    .from('moradores')
    .update({ aceite_tc: true, atualizado_em: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

async function atualizarFotoMorador(id, fotoUrl) {
  const { error } = await supabase()
    .from('moradores')
    .update({ foto_url: fotoUrl })
    .eq('id', id)
  if (error) throw error
}

// ─── SESSÕES ──────────────────────────────────────────────────────

async function buscarSessao(celular) {
  const { data, error } = await supabase()
    .from('sessoes_cadastro')
    .select('*')
    .eq('celular', celular)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  if (!data) return null
  const idade = Date.now() - new Date(data.atualizado_em).getTime()
  if (idade > 24 * 60 * 60 * 1000) {
    await deletarSessao(celular)
    return null
  }
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

// Busca sessoes abandonadas do dia anterior (para cron diario)
async function buscarSessoesAbandonadas() {
  const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase()
    .from('sessoes_cadastro')
    .select('celular')
    .lt('atualizado_em', ontem)
  if (error) return []
  return data || []
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
    .select('id, nome, flag_auto_aprovacao')
    .order('nome')
  if (error) throw error
  return data
}

// ─── BLOCOS ───────────────────────────────────────────────────────

async function listarBlocosPorCondominio(condominioId) {
  const { data, error } = await supabase()
    .from('blocos')
    .select('id, nome')
    .eq('condominio_id', condominioId)
    .order('nome')
  if (error) {
    // Se tabela nao existe ainda, retorna vazio
    if (error.code === '42P01') return []
    throw error
  }
  return data || []
}

// ─── GELADEIRAS ───────────────────────────────────────────────────

async function buscarGeladeiraPorCodigo(codigo) {
  const match = codigo.match(/@(.+)/)
  const nomeCondominio = match ? match[1].trim() : null
  const nomeGeladeira = codigo.split('@')[0].trim()

  let query = supabase()
    .from('geladeiras')
    .select('*, condominios(*)')
    .ilike('nome', `%${nomeGeladeira}%`)

  if (nomeCondominio) {
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

// Extrai condominio de um codigo de geladeira
function extrairCondominioDeComando(mensagem) {
  const match = mensagem.match(/@(.+)/)
  return match ? match[1].trim() : null
}

// ─── COMANDOS GELADEIRA (polling do Pi) ──────────────────────────

async function inserirComandoGeladeira(geladeiraId, moradorId) {
  const { error } = await supabase().from('comandos_esp32').insert([{
    geladeira_id: geladeiraId,
    morador_id: moradorId,
    comando: 'abrir',
    status: 'pendente',
    criado_em: new Date().toISOString(),
  }])
  if (error) throw error
}

// ─── LOGS ─────────────────────────────────────────────────────────

async function registrarLog(moradorId, geladeiraId, tipo, resultado, detalhes) {
  const { error } = await supabase().from('logs_acesso').insert([{
    morador_id: moradorId,
    geladeira_id: geladeiraId,
    tipo,
    resultado,
    detalhes,
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

// ─── ADMINS ───────────────────────────────────────────────────────

async function listarAdmins() {
  const { data, error } = await supabase()
    .from('admins_whatsapp')
    .select('*')
    .eq('ativo', true)
  if (error) throw error
  return data || []
}

async function adicionarAdmin(celular, nome) {
  const { error } = await supabase()
    .from('admins_whatsapp')
    .upsert([{ celular, nome, ativo: true }], { onConflict: 'celular' })
  if (error) throw error
}

async function removerAdmin(celular) {
  const { error } = await supabase()
    .from('admins_whatsapp')
    .update({ ativo: false })
    .eq('celular', celular)
  if (error) throw error
}

async function listarMoradoresPorStatus(status) {
  const { data, error } = await supabase()
    .from('moradores')
    .select('*, condominios(nome)')
    .eq('status', status)
    .order('criado_em', { ascending: false })
    .limit(20)
  if (error) throw error
  return data || []
}

async function contarPendentes() {
  const { count, error } = await supabase()
    .from('moradores')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pendente')
  if (error) return 0
  return count || 0
}

async function buscarMoradorParaAcao(busca) {
  const limpo = busca.replace(/\D/g, '')
  if (limpo.length >= 10) {
    const porCelular = await buscarMoradorPorCelular(limpo.length === 11 ? `55${limpo}` : limpo)
    if (porCelular) return porCelular
  }
  const { data, error } = await supabase()
    .from('moradores')
    .select('*, condominios(*)')
    .ilike('nome', `%${busca}%`)
    .limit(1)
    .single()
  if (error && error.code !== 'PGRST116') return null
  return data
}

module.exports = {
  buscarMoradorPorCelular,
  buscarMoradorPorCPF,
  criarMorador,
  atualizarStatusMorador,
  atualizarAceiteTCMorador,
  atualizarFotoMorador,
  buscarSessao,
  salvarSessao,
  deletarSessao,
  buscarSessoesAbandonadas,
  buscarCondominioPorNome,
  listarCondominios,
  listarBlocosPorCondominio,
  buscarGeladeiraPorCodigo,
  extrairCondominioDeComando,
  inserirComandoGeladeira,
  registrarLog,
  uploadFoto,
  listarAdmins,
  adicionarAdmin,
  removerAdmin,
  listarMoradoresPorStatus,
  contarPendentes,
  buscarMoradorParaAcao,
}
