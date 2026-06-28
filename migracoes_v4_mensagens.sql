-- ============================================================
-- SelfStore Bot v4 — Tabela mensagens_bot (T3-01)
-- Execute no SQL Editor do Supabase
-- ============================================================

CREATE TABLE IF NOT EXISTS mensagens_bot (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  celular TEXT NOT NULL,
  direcao TEXT NOT NULL CHECK (direcao IN ('enviada', 'recebida')),
  conteudo TEXT,
  tipo TEXT NOT NULL DEFAULT 'texto',
  sessao_id TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_celular_criado ON mensagens_bot(celular, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_msg_sessao ON mensagens_bot(sessao_id) WHERE sessao_id IS NOT NULL;

-- ============================================================
-- Pronto! Índice composto (celular, criado_em) otimiza:
-- - Busca de transcript por morador (T3-06 AJUDA)
-- - Listagem de conversas no painel (T3-09)
-- ============================================================
