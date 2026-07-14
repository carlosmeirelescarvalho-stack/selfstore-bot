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

async function buscarMoradorPorCpfNumerico(cpfInt) {
  const cpfStr = String(cpfInt).padStart(11, '0')
  const { data, error } = await supabase()
    .from('moradores')
    .select('*, condominios(nome)')
    .eq('cpf', cpfStr)
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

async function atualizarUltimoAcesso(moradorId) {
  try {
    await supabase()
      .from('moradores')
      .update({ ultimo_acesso: new Date().toISOString() })
      .eq('id', moradorId)
  } catch (e) { console.error('Erro ao atualizar ultimo_acesso:', e.message) }
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

async function buscarCondominioPorId(id) {
  const { data, error } = await supabase()
    .from('condominios')
    .select('*')
    .eq('id', id)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data
}

// ─── BLOCOS ───────────────────────────────────────────────────────

async function listarBlocosPorCondominio(condominioId) {
  const { data, error } = await supabase()
    .from('blocos')
    .select('id, nome, ordem')
    .eq('condominio_id', condominioId)
    .order('ordem', { nullsFirst: false })
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

// ─── MENSAGENS BOT ───────────────────────────────────────────────

async function registrarMensagem(celular, direcao, conteudo, tipo, sessaoId) {
  try {
    await supabase().from('mensagens_bot').insert([{
      celular,
      direcao,
      conteudo: (conteudo || '').substring(0, 4000),
      tipo: tipo || 'texto',
      sessao_id: sessaoId || null,
    }])
  } catch (e) {
    console.error('Erro registrarMensagem:', e.message)
  }
}

async function buscarMensagensPorCelular(celular, limite) {
  const { data, error } = await supabase()
    .from('mensagens_bot')
    .select('*')
    .eq('celular', celular)
    .order('criado_em', { ascending: false })
    .limit(limite || 20)
  if (error) return []
  return (data || []).reverse()
}

async function listarContatosRecentes(limite) {
  const { data, error } = await supabase()
    .from('mensagens_bot')
    .select('celular, criado_em, conteudo, direcao')
    .order('criado_em', { ascending: false })
    .limit(500)
  if (error) return []
  const map = {}
  for (const m of (data || [])) {
    if (!map[m.celular]) {
      map[m.celular] = { celular: m.celular, ultima_msg: m.criado_em, preview: m.conteudo, direcao: m.direcao }
    }
  }
  return Object.values(map)
    .sort((a, b) => new Date(b.ultima_msg) - new Date(a.ultima_msg))
    .slice(0, limite || 30)
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
    .select('*, admins_condominios(condominio_id, condominios(id, nome))')
    .eq('ativo', true)
  if (error) throw error
  return data || []
}

async function adicionarAdmin(celular, nome, cpf, condominioIds) {
  const { data, error } = await supabase()
    .from('admins_whatsapp')
    .upsert([{ celular, nome, cpf: cpf || null, ativo: true }], { onConflict: 'celular' })
    .select()
    .single()
  if (error) throw error
  if (condominioIds?.length && data?.id) {
    await supabase().from('admins_condominios').delete().eq('admin_id', data.id)
    const rows = condominioIds.map(cid => ({ admin_id: data.id, condominio_id: cid }))
    await supabase().from('admins_condominios').insert(rows)
  }
  return data
}

async function atualizarAdmin(id, campos, condominioIds) {
  const { error } = await supabase()
    .from('admins_whatsapp')
    .update(campos)
    .eq('id', id)
  if (error) throw error
  if (condominioIds !== undefined) {
    await supabase().from('admins_condominios').delete().eq('admin_id', id)
    if (condominioIds?.length) {
      const rows = condominioIds.map(cid => ({ admin_id: id, condominio_id: cid }))
      await supabase().from('admins_condominios').insert(rows)
    }
  }
}

async function removerAdmin(id) {
  await supabase().from('admins_condominios').delete().eq('admin_id', id)
  const { error } = await supabase()
    .from('admins_whatsapp')
    .update({ ativo: false })
    .eq('id', id)
  if (error) throw error
}

async function buscarAdminsPorCondominio(condominioId) {
  const { data, error } = await supabase()
    .from('admins_condominios')
    .select('admin_id, admins_whatsapp(celular, nome, ativo)')
    .eq('condominio_id', condominioId)
  if (error) return []
  return (data || [])
    .filter(r => r.admins_whatsapp?.ativo)
    .map(r => r.admins_whatsapp)
}

async function deletarMorador(id) {
  await supabase().from('logs_acesso').delete().eq('morador_id', id)
  const { error } = await supabase().from('moradores').delete().eq('id', id)
  if (error) throw error
}

async function excluirDadosMorador(id, fotoUrl, celular) {
  if (fotoUrl) {
    try {
      const url = new URL(fotoUrl)
      const pathMatch = url.pathname.match(/\/object\/public\/selfstore\/(.+)/)
      if (pathMatch) {
        await supabase().storage.from('selfstore').remove([pathMatch[1]])
      }
    } catch (e) {
      console.warn('Exclusão LGPD: falha ao remover foto do storage:', e.message)
    }
  }
  if (celular) {
    await supabase().from('sessoes_cadastro').delete().eq('celular', celular)
  }
  await supabase().from('logs_acesso').delete().eq('morador_id', id)
  const { error } = await supabase().from('moradores').delete().eq('id', id)
  if (error) throw error
}

async function atualizarMorador(id, campos) {
  const { data, error } = await supabase()
    .from('moradores')
    .update({ ...campos, atualizado_em: new Date().toISOString() })
    .eq('id', id)
    .select('*, condominios(*)')
    .single()
  if (error) throw error
  return data
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
  supabase,
  buscarMoradorPorCelular,
  buscarMoradorPorCPF,
  buscarMoradorPorCpfNumerico,
  criarMorador,
  atualizarStatusMorador,
  atualizarAceiteTCMorador,
  atualizarUltimoAcesso,
  atualizarFotoMorador,
  buscarSessao,
  salvarSessao,
  deletarSessao,
  buscarSessoesAbandonadas,
  buscarCondominioPorNome,
  buscarCondominioPorId,
  listarCondominios,
  listarBlocosPorCondominio,
  buscarGeladeiraPorCodigo,
  extrairCondominioDeComando,
  inserirComandoGeladeira,
  registrarLog,
  registrarMensagem,
  buscarMensagensPorCelular,
  uploadFoto,
  listarAdmins,
  adicionarAdmin,
  atualizarAdmin,
  removerAdmin,
  buscarAdminsPorCondominio,
  deletarMorador,
  excluirDadosMorador,
  atualizarMorador,
  listarMoradoresPorStatus,
  contarPendentes,
  buscarMoradorParaAcao,
  listarContatosRecentes,
}
