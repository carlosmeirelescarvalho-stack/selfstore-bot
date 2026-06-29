# SelfStore Bot — Guia de Deploy

## O que é
Chatbot WhatsApp para controle de acesso ao Self Store do condomínio. 
Permite cadastro de moradores via WhatsApp e abertura de geladeira via QR Code.

## Arquitetura
```
WhatsApp ←→ Meta Cloud API ←→ Este servidor ←→ Supabase (banco)
                                            ←→ iDFace Pro (reconhecimento facial)
                                            ←→ Raspberry Pi (abertura de geladeira)
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

## PASSO 3 — Deploy do Bot no Railway
1. Acesse railway.app e crie uma conta
2. Clique em **New Project > Deploy from GitHub repo**
3. Selecione o repositório `selfstore-bot`
4. Em **Variables**, adicione todas as variáveis do `.env.example` com seus valores reais
5. O Railway detecta o `package.json` e faz o deploy automaticamente
6. Copie a URL do bot (ex: `https://selfstore-bot-xxx.railway.app`)

---

## PASSO 4 — Configurar Webhook na Meta
1. No Meta Business Manager, crie um App do tipo Business
2. Configure o WhatsApp product e obtenha o Phone Number ID e token permanente
3. Configure o webhook apontando para: `https://selfstore-bot-xxx.railway.app/webhook/whatsapp`
4. Use o verify token definido em `META_WEBHOOK_VERIFY_TOKEN`
5. Assine os campos: `messages`, `account_alerts`

---

## PASSO 5 — Configurar o iDFace Pro
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

## PASSO 6 — Configurar o Raspberry Pi
1. Instale o Raspberry Pi OS e conecte ao Wi-Fi
2. Copie o script `geladeira.py` e configure o serviço systemd
3. No Supabase, atualize o registro da geladeira:
   ```sql
   UPDATE geladeiras
   SET esp32_ip = '192.168.1.101'
   WHERE nome = 'Geladeira 1 @Adele Zarzur';
   ```

---

## PASSO 7 — Gerar os QR Codes
### QR Code de cadastro (afixar no condomínio):
```
https://wa.me/55SEUNUMERO?text=CADASTRO%20@Adele%20Zarzur
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
