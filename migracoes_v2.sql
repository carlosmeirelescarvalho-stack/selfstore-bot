-- ============================================================
-- SelfStore Bot v2 — Migrações de banco de dados
-- Execute no SQL Editor do Supabase (supabase.com > projeto > SQL Editor)
-- ============================================================

-- 1. Adicionar campo aceite_tc na tabela moradores
ALTER TABLE moradores
  ADD COLUMN IF NOT EXISTS aceite_tc BOOLEAN DEFAULT FALSE;

-- 2. Criar tabela blocos (blocos/torres por condomínio)
CREATE TABLE IF NOT EXISTS blocos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  condominio_id UUID NOT NULL REFERENCES condominios(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para busca rápida por condomínio
CREATE INDEX IF NOT EXISTS idx_blocos_condominio ON blocos(condominio_id);

-- 3. Criar tabela comandos_esp32 (polling do Pi para abrir geladeira)
CREATE TABLE IF NOT EXISTS comandos_esp32 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  geladeira_id UUID NOT NULL REFERENCES geladeiras(id) ON DELETE CASCADE,
  morador_id UUID REFERENCES moradores(id),
  comando TEXT NOT NULL DEFAULT 'abrir',
  status TEXT NOT NULL DEFAULT 'pendente',
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  executado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_comandos_esp32_status ON comandos_esp32(geladeira_id, status);

-- 4. Habilitar RLS (Row Level Security) nas novas tabelas
-- (descomente se você usa RLS no projeto)
-- ALTER TABLE blocos ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE comandos_esp32 ENABLE ROW LEVEL SECURITY;

-- 5. Inserir blocos do Adele Zarzur (ajuste conforme necessário)
-- Primeiro, busque o ID do condomínio:
-- SELECT id FROM condominios WHERE nome ILIKE '%Adele%';
-- Depois insira os blocos (substitua 'SEU_CONDOMINIO_ID'):
--
-- INSERT INTO blocos (condominio_id, nome) VALUES
--   ('SEU_CONDOMINIO_ID', 'Bloco A'),
--   ('SEU_CONDOMINIO_ID', 'Bloco B'),
--   ('SEU_CONDOMINIO_ID', 'Bloco C'),
--   ('SEU_CONDOMINIO_ID', 'Bloco D'),
--   ('SEU_CONDOMINIO_ID', 'Bloco E'),
--   ('SEU_CONDOMINIO_ID', 'Bloco F'),
--   ('SEU_CONDOMINIO_ID', 'Bloco G'),
--   ('SEU_CONDOMINIO_ID', 'Bloco H'),
--   ('SEU_CONDOMINIO_ID', 'Bloco I'),
--   ('SEU_CONDOMINIO_ID', 'Bloco J'),
--   ('SEU_CONDOMINIO_ID', 'Bloco K');

-- ============================================================
-- Pronto! Após executar, o bot v2 já consegue usar:
-- - aceite_tc nos moradores
-- - blocos por condomínio
-- - comandos de abertura via polling
-- ============================================================
