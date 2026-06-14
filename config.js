// config.js — todas as variáveis de ambiente ficam aqui
// Você vai preencher esses valores no Railway (em "Variables")
// NUNCA suba esse arquivo com valores reais para o GitHub

module.exports = {
  // Porta do servidor
  PORT: process.env.PORT || 3000,

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,

  // Evolution API
  EVOLUTION_API_URL: process.env.EVOLUTION_API_URL,   // ex: https://sua-evolution.railway.app
  EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE || 'selfstore',

  // iDFace (por condomínio — configurado no painel admin)
  // IPs e senhas ficam no banco, não aqui

  // Admin
  ADMIN_CELULAR: process.env.ADMIN_CELULAR, // ex: 5511999999999
  // Número do WhatsApp do sistema (sem + e sem espaços)
  BOT_NUMERO: process.env.BOT_NUMERO,

  // Tempo que a geladeira fica aberta (ms) — espelha TEMPO_ABERTA do geladeira.py
  GELADEIRA_TEMPO_ABERTA_MS: 15000,

  // Chave secreta compartilhada com o Raspberry Pi (polling)
  ESP32_SECRET: process.env.ESP32_SECRET || 'troque-por-uma-chave-secreta-forte',
}
