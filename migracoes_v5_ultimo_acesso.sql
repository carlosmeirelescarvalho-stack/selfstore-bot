-- Migração v5: último acesso dos moradores
-- Executar no Supabase SQL Editor

ALTER TABLE moradores ADD COLUMN IF NOT EXISTS ultimo_acesso TIMESTAMPTZ;
