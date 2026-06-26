-- ============================================================
-- SelfStore Bot v3 — Migrações (admins multi-condomínio, CPF admin)
-- Execute no SQL Editor do Supabase
-- ============================================================

-- 1. Adicionar CPF à tabela admins_whatsapp
ALTER TABLE admins_whatsapp
  ADD COLUMN IF NOT EXISTS cpf TEXT;

-- 2. Criar tabela de vínculo admin ↔ condomínio
CREATE TABLE IF NOT EXISTS admins_condominios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES admins_whatsapp(id) ON DELETE CASCADE,
  condominio_id UUID NOT NULL REFERENCES condominios(id) ON DELETE CASCADE,
  UNIQUE(admin_id, condominio_id)
);

CREATE INDEX IF NOT EXISTS idx_admins_cond_admin ON admins_condominios(admin_id);
CREATE INDEX IF NOT EXISTS idx_admins_cond_cond ON admins_condominios(condominio_id);

-- 3. Garantir coluna flag_alcoolica em geladeiras (caso não exista)
ALTER TABLE geladeiras
  ADD COLUMN IF NOT EXISTS flag_alcoolica BOOLEAN DEFAULT false;

-- ============================================================
-- Pronto! Após executar, o bot v3 usa:
-- - CPF no cadastro de admins (vincula à foto do morador)
-- - Notificações por condomínio (admin sem vínculo = não recebe)
-- - Flag +18 por geladeira (restrição álcool)
-- ============================================================
