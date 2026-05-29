-- =====================================================
-- SELFSTORE — Script de criação do banco no Supabase
-- Cole este SQL no editor do Supabase (SQL Editor)
-- e clique em Run
-- =====================================================

-- Condomínios
CREATE TABLE condominios (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                 TEXT NOT NULL,
  flag_auto_aprovacao  BOOLEAN NOT NULL DEFAULT false,
  idface_ip            TEXT,
  idface_senha         TEXT,
  criado_em            TIMESTAMPTZ DEFAULT now()
);

-- Moradores
CREATE TABLE moradores (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome               TEXT NOT NULL,
  cpf                TEXT NOT NULL UNIQUE,
  data_nasc          DATE NOT NULL,
  telefone           TEXT,
  celular_whatsapp   TEXT NOT NULL UNIQUE,
  condominio_id      UUID REFERENCES condominios(id),
  bloco              TEXT,
  unidade            TEXT,
  foto_url           TEXT,
  status             TEXT NOT NULL DEFAULT 'pendente'
                     CHECK (status IN ('pendente','aprovado','rejeitado')),
  criado_em          TIMESTAMPTZ DEFAULT now(),
  atualizado_em      TIMESTAMPTZ DEFAULT now()
);

-- Geladeiras
CREATE TABLE geladeiras (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome            TEXT NOT NULL,
  condominio_id   UUID REFERENCES condominios(id),
  esp32_ip        TEXT,
  flag_alcoolica  BOOLEAN NOT NULL DEFAULT true,
  ativa           BOOLEAN NOT NULL DEFAULT true,
  criado_em       TIMESTAMPTZ DEFAULT now()
);

-- Sessões de cadastro (estado da conversa no WhatsApp)
CREATE TABLE sessoes_cadastro (
  celular        TEXT PRIMARY KEY,
  etapa_atual    TEXT NOT NULL,
  dados_parciais JSONB DEFAULT '{}',
  atualizado_em  TIMESTAMPTZ DEFAULT now()
);

-- Logs de acesso
CREATE TABLE logs_acesso (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  morador_id   UUID REFERENCES moradores(id),
  geladeira_id UUID REFERENCES geladeiras(id),
  tipo         TEXT NOT NULL CHECK (tipo IN ('whatsapp','facial')),
  resultado    TEXT NOT NULL CHECK (resultado IN ('aberto','negado')),
  detalhes     TEXT,
  criado_em    TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- DADOS INICIAIS DE EXEMPLO
-- Ajuste com seus dados reais antes de usar
-- =====================================================

INSERT INTO condominios (nome, flag_auto_aprovacao)
VALUES ('Adele Zarzur', false);

INSERT INTO geladeiras (nome, condominio_id, flag_alcoolica)
SELECT 'Geladeira 1 @Adele Zarzur', id, true
FROM condominios WHERE nome = 'Adele Zarzur';

-- =====================================================
-- BUCKET DE ARMAZENAMENTO DE FOTOS
-- Crie manualmente em Storage > New bucket
-- Nome: selfstore
-- Public bucket: SIM
-- =====================================================
