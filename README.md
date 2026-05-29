# SelfStore Bot — Guia de Deploy

## O que é
Chatbot WhatsApp para controle de acesso ao Self Store do condomínio. 
Permite cadastro de moradores via WhatsApp e abertura de geladeira via QR Code.

## Arquitetura
```
WhatsApp ←→ Evolution API ←→ Este servidor ←→ Supabase (banco)
                                            ←→ iDFace Pro (reconhecimento facial)
                                            ←→ ESP32 (abertura de geladeira)
```

---

## PASSO 1 — Criar conta no GitHub
1. Acesse github.com e crie uma conta gratuita
2. Crie um repositório novo chamado `selfstore-bot`
3. Faça upload de todos os arquivos desta pasta

---

## PASSO 2 — Criar banco no Supabase
1. Acesse supabase.com e crie uma conta gratuita
2. Crie um novo projeto (guarde a senha do banco)
3. Em **SQL Editor**, cole o conteúdo de `banco.sql` e clique em **Run**
4. Em **Storage**, crie um bucket chamado `selfstore` (marque como público)
5. Em **Settings > API**, copie:
   - `Project URL` → é o SUPABASE_URL
   - `anon public key` → é o SUPABASE_KEY

---

## PASSO 3 — Deploy da Evolution API no Railway
1. Acesse railway.app e crie uma conta gratuita
2. Clique em **New Project > Deploy from template**
3. Busque por `Evolution API` e selecione o template oficial
4. Aguarde o deploy (~3 min)
5. Copie a URL gerada (ex: `https://evolution-api-xxx.railway.app`)
6. Acesse `https://sua-url.railway.app` e configure:
   - Crie uma instância chamada `selfstore`
   - Conecte o WhatsApp escaneando o QR Code com o celular do bot
   - Guarde a API Key gerada

---

## PASSO 4 — Deploy do Bot no Railway
1. No Railway, clique em **New Project > Deploy from GitHub repo**
2. Selecione o repositório `selfstore-bot`
3. Em **Variables**, adicione todas as variáveis do `.env.example` com seus valores reais
4. O Railway detecta o `package.json` e faz o deploy automaticamente
5. Copie a URL do bot (ex: `https://selfstore-bot-xxx.railway.app`)

---

## PASSO 5 — Configurar Webhook na Evolution API
1. No painel da Evolution API, vá em **Webhooks**
2. Configure o webhook para sua instância `selfstore`:
   - URL: `https://selfstore-bot-xxx.railway.app/webhook`
   - Eventos: `messages.upsert`
3. Salve e teste enviando uma mensagem no WhatsApp

---

## PASSO 6 — Configurar o iDFace Pro
1. Acesse o iDFace pelo IP na rede local (ex: `192.168.1.100`)
2. No painel do Supabase, atualize o registro do condomínio:
   ```sql
   UPDATE condominios
   SET idface_ip = '192.168.1.100', idface_senha = 'sua-senha'
   WHERE nome = 'Adele Zarzur';
   ```
3. Configure o modo **Online (Pro)** no iDFace
4. Configure o push de eventos para: `https://selfstore-bot-xxx.railway.app/webhook/idface`

---

## PASSO 7 — Configurar o ESP32
1. Grave o firmware no ESP32 (código separado)
2. Configure o Wi-Fi e anote o IP local (ex: `192.168.1.101`)
3. No Supabase, atualize o registro da geladeira:
   ```sql
   UPDATE geladeiras
   SET esp32_ip = '192.168.1.101'
   WHERE nome = 'Geladeira 1 @Adele Zarzur';
   ```

---

## PASSO 8 — Gerar os QR Codes
### QR Code de cadastro (afixar no condomínio):
```
https://wa.me/55SEUNUMERO?text=Oi!+Quero+fazer+meu+cadastro+no+Self+Store+Adele+Zarzur
```

### QR Code da geladeira (afixar na geladeira):
```
https://wa.me/55SEUNUMERO?text=ABRIR+Geladeira+1+@Adele+Zarzur
```

Use qualquer gerador de QR Code gratuito (ex: qr-code-generator.com).
Imprima, plastifique e cole no local correto.

---

## Testando
1. Aponte a câmera para o QR Code de cadastro
2. Envie a mensagem pré-preenchida
3. Siga o fluxo de cadastro
4. Após aprovação (pelo painel admin), aponte para o QR Code da geladeira
5. A geladeira deve abrir em menos de 2 segundos

---

## Suporte
Em caso de problemas, verifique os logs no Railway em **Deployments > Logs**.
