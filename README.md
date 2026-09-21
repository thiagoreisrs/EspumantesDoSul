# Agente de atendimento WhatsApp — Espumantes do Sul

Atendente virtual para o WhatsApp da loja, ligado ao **Chatwoot** como *Agent Bot*.
Ele lê as mensagens do cliente, decide se deve responder, consulta **Shopify**
(pedidos e catálogo) e **Olist Tiny ERP** (pedidos, rastreio e estoque) quando
precisa de dado real, e **transfere para um atendente humano** sempre que a
conversa sai do que ele pode resolver com segurança.

## Como funciona

```
WhatsApp  ──►  Chatwoot  ──webhook──►  este serviço  ──►  Claude (tool use)
                  ▲                          │                    │
                  │                          │            ┌───────┴────────┐
                  │                          ▼            ▼                ▼
                  └────── resposta / ──── decisão      Shopify        Olist Tiny
                          handoff                    (pedidos,        (pedidos,
                                                      catálogo)      rastreio, estoque)
```

**O Chatwoot não fala com o Claude sozinho.** Não existe integração nativa entre
os dois: o Chatwoot expõe webhooks de *Agent Bot* e uma API REST, e este serviço
é a peça no meio que recebe o evento, roda o agente e devolve a resposta.

### O ciclo de um atendimento

1. Cliente manda mensagem no WhatsApp; o Chatwoot dispara `message_created`.
2. O **portão** (`src/agent/policy.ts`) decide se o bot deve agir. Ele se cala
   quando a conversa saiu de `pending`, quando há atendente atribuído, quando a
   conversa tem o rótulo `bot-pausado`, quando a mensagem é nota privada, ou
   quando o anexo é áudio/vídeo/documento (esses vão direto para humano).
3. O **agrupador** (`src/conversation/scheduler.ts`) espera 8 segundos. No
   WhatsApp o cliente manda "oi", "é sobre meu pedido", "o 1234" em três
   mensagens — o agente responde a intenção completa, uma vez só. O agrupador
   também garante uma execução por vez por conversa.
4. O **agente** (`src/agent/run.ts`) roda com o histórico da conversa e as
   ferramentas. Ele consulta o que precisar e produz a resposta.
5. A **entrega** (`src/agent/handler.ts`) envia a resposta ou executa o handoff:
   nota interna com o resumo, rótulo `escalado-bot`, atribuição ao time e
   mudança do status para `open` — que é o que tira a conversa do bot.

### Ferramentas disponíveis ao agente

| Ferramenta | O que faz | Fonte |
|---|---|---|
| `buscar_pedido` | Status, itens, valor e pagamento de um pedido | Shopify, com fallback no ERP |
| `rastrear_entrega` | Transportadora, código e link de rastreio | Shopify + Olist |
| `buscar_produto` | Nome, preço, disponibilidade e link | Shopify |
| `consultar_estoque` | Saldo real em estoque | Olist |
| `escalar_para_humano` | Transfere com motivo e resumo | — |
| `nao_responder` | Encerra em silêncio (spam, engano de número) | — |

### O que impede o agente de inventar ou vazar dado

Estas garantias estão **no código**, não apenas no prompt:

- **Titularidade do pedido.** `isOrderOwnedByContact` só libera os dados se o
  telefone do pedido bater com o do WhatsApp, ou se o cliente informar o e-mail
  usado na compra. Sem isso, a ferramenta devolve uma recusa — o modelo nunca
  chega a ver os dados do pedido de outra pessoa.
- **Falha de ferramenta nunca vira chute.** Erro em qualquer integração retorna
  `is_error` com instrução explícita de escalar.
- **Resposta truncada não é enviada.** `stop_reason: max_tokens` vira handoff.
- **Recusa do modelo vira handoff**, não silêncio.
- **Teto de iterações** (6 por mensagem); ao estourar, escala.
- **Exceção não tratada** devolve a conversa para a fila humana com nota interna.

O agente escala sozinho em: reclamação, produto avariado, troca/devolução/estorno,
negociação de desconto, pedido explícito de atendente, assunto de pagamento,
suspeita de menor de idade, e baixa confiança.

## Configuração

### 1. Chatwoot

1. **Configurações → Agent Bots → novo bot.** Guarde o *access token*.
2. Gere um segredo para o webhook: `openssl rand -hex 24`.
3. Configure a URL do bot como
   `https://seu-host/webhooks/chatwoot/<CHATWOOT_WEBHOOK_SECRET>`.
   O Chatwoot **não assina** os webhooks de agent bot, por isso o segredo vai na
   URL e é comparado em tempo constante.
4. Associe o bot à inbox de WhatsApp.
5. Crie os rótulos `escalado-bot` e `bot-pausado`.

### 2. Shopify

Crie um app customizado na loja com os escopos de leitura:
`read_orders`, `read_products`, `read_inventory`, `read_fulfillments`.
Use o *Admin API access token* (`shpat_...`).

### 3. Olist Tiny (API v3)

1. No painel da Olist, crie um aplicativo e pegue `client_id` e `client_secret`.
2. Cadastre `http://localhost:8788/callback` como URL de redirecionamento.
3. Rode o consentimento uma única vez:

   ```bash
   OLIST_CLIENT_ID=... OLIST_CLIENT_SECRET=... node scripts/olist-consent.mjs
   ```

   Copie o `OLIST_REFRESH_TOKEN` impresso para o `.env`.

> O Keycloak da Olist **rotaciona o refresh token** a cada renovação. Por isso
> `OLIST_TOKEN_STORE` precisa apontar para um caminho gravável e **persistente**
> (um volume, não o filesystem efêmero do container). Sem isso o agente perde o
> acesso ao ERP no primeiro deploy após a validade do token original.

### 4. Base de conhecimento

**Preencha `knowledge/politicas.md` antes de subir.** Frete, prazo, pagamento,
troca e devolução saem exclusivamente desse arquivo — o que não estiver lá, o
agente escala em vez de inventar. O arquivo é lido na subida do processo; editá-lo
exige reiniciar (ou remontar o volume), não um rebuild.

### 5. Variáveis de ambiente

Copie `.env.example` para `.env` e preencha. A configuração é validada com Zod na
subida: falta de segredo derruba o processo no boot, em vez de no meio de um
atendimento.

## Rodando

```bash
npm install
npm run dev          # desenvolvimento, com reload
npm test             # 32 testes
npm run typecheck
npm run build && npm start
```

Em desenvolvimento, exponha o serviço para o Chatwoot com um túnel
(`cloudflared tunnel --url http://localhost:3000` ou ngrok) e aponte a URL do bot
para o túnel.

## Deploy

### Coolify (recomendado)

Crie a aplicação como **Git Repository (with GitHub App)** — é a única opção que
cobre repositório privado, deploy automático a cada push e build a partir do
`Dockerfile` do repositório.

| Campo | Valor |
|---|---|
| Source | GitHub App → `thiagoreisrs/EspumantesDoSul` |
| Branch | `main` (só depois que o código estiver mergeado nela — ver aviso abaixo) |
| Build Pack | **Dockerfile** |
| Ports Exposes | `3000` |
| Health Check Path | `/health` |
| Domínio | um subdomínio seu, com HTTPS ativado |

> **Aponte o Coolify para um branch que tenha o código.** O `main` deste
> repositório nasceu de um commit inicial vazio, para servir de base ao primeiro
> pull request. Enquanto esse PR não for mergeado, um deploy de `main` falha com
> `failed to read dockerfile: open Dockerfile: no such file or directory` — não é
> problema do Dockerfile, é o branch que não tem arquivo nenhum. Confirme com
> `git ls-tree --name-only origin/main` antes do primeiro deploy.

Dois pontos que quebram em produção se forem pulados:

1. **Volume persistente em `/data`.** Em *Storages*, monte um volume para
   `/data` e mantenha `OLIST_TOKEN_STORE=/data/.olist-token.json`. O refresh
   token da Olist é rotativo: sem volume, o acesso ao ERP morre no primeiro
   redeploy.
2. **HTTPS é obrigatório.** O Chatwoot só entrega webhook para endpoint público
   com TLS.

As demais variáveis são as de `.env.example`, cadastradas na UI do Coolify.

> **`knowledge/politicas.md` é assado na imagem.** Com build por Dockerfile,
> editar as políticas exige rebuild. Para editar sem redeploy, monte também um
> volume de arquivo apontando para `/app/knowledge/politicas.md` e reinicie o
> container depois de editar.

Se preferir declarar tudo no repositório, o build pack **Docker Compose** também
funciona com o `docker-compose.yml` incluído — nesse caso remova o bloco `ports`
e descomente `SERVICE_FQDN_AGENTE_3000`, porque quem publica a porta passa a ser
o proxy do Coolify.

### Docker Compose (VPS própria ou máquina local)

```bash
cp .env.example .env    # preencha os segredos
docker compose up -d --build
docker compose logs -f agente
```

O arquivo já traz volume nomeado para `/data`, `restart: unless-stopped`,
rotação de log e healthcheck em `/health`. Para editar as políticas da loja sem
rebuild, descomente o bind mount de `knowledge/politicas.md`.

### Depois do deploy

1. Confirme a saúde: `curl https://seu-dominio/health` deve devolver
   `{"status":"ok",...}`.
2. No Chatwoot, configure a URL do Agent Bot como
   `https://seu-dominio/webhooks/chatwoot/<CHATWOOT_WEBHOOK_SECRET>`.
3. Valide que a autenticação do webhook está de pé — um segredo errado precisa
   devolver `401`:

   ```bash
   curl -o /dev/null -w "%{http_code}\n" -X POST \
     https://seu-dominio/webhooks/chatwoot/errado \
     -H 'content-type: application/json' -d '{}'
   ```

4. Rode o consentimento da Olist (uma vez) e cadastre o `OLIST_REFRESH_TOKEN`.
5. Mande uma mensagem de teste na inbox e acompanhe os logs.

## Operação do dia a dia

| Situação | O que fazer |
|---|---|
| Atendente quer assumir uma conversa | Atribuir a conversa a si, ou mudar o status para `open`. O bot se cala sozinho. |
| Silenciar o bot permanentemente numa conversa | Aplicar o rótulo `bot-pausado`. |
| Ver por que o bot escalou | Ler a nota interna; ela traz motivo, ferramentas consultadas e resumo. |
| Desligar o bot inteiro | Desassociar o agent bot da inbox no Chatwoot. |
| Auditar o custo | Cada atendimento loga `tokens_entrada`, `tokens_saida` e `tokens_cache`. |

O prompt de sistema e as definições de ferramenta ficam num prefixo cacheado
(`cache_control: ephemeral`). Se `tokens_cache` vier zerado em mensagens
seguidas, algo passou a variar no prefixo — é o sinal de que o cache quebrou.

## Ajustes de comportamento

| Variável | Efeito |
|---|---|
| `CLAUDE_EFFORT` | `medium` é o padrão para atendimento. Suba para `high` se a qualidade cair; `low` corta custo em conversas simples. |
| `DEBOUNCE_MS` | Janela de agrupamento. Menor = mais reativo, mais respostas fragmentadas. |
| `AGENT_MAX_ITERATIONS` | Teto de consultas por mensagem antes de escalar. |
| `HISTORY_LIMIT` | Quantas mensagens da conversa entram no contexto. |
| `BUSINESS_*` / `TIMEZONE` | Muda a mensagem de transferência dentro e fora do horário. |

## Estado de verificação

O que foi **verificado nesta máquina**: typecheck limpo, 32 testes passando,
build, smoke test do servidor (health, rejeição de segredo inválido, filtragem
de evento e agendamento), `docker compose config` válido, e o comando de
healthcheck testado nos dois estados (sai 0 com o servidor no ar, 1 com ele
parado).

O que **não foi exercitado**:

- **`docker build`.** Não havia daemon Docker no ambiente onde o projeto foi
  escrito, então a imagem nunca foi construída. O runtime foi testado
  diretamente (`node dist/index.js`), mas rode um `docker build` local antes de
  apontar o Coolify para cá.

O que **ainda não foi exercitado contra as APIs reais**, por não haver
credenciais aqui:

- **Chatwoot.** Os endpoints seguem a Application API v1 (`/api/v1/accounts/...`),
  estável há várias versões. A documentação oficial estava bloqueada pelo proxy
  de rede desta sessão, então confira `toggle_status`, `assignments`, `labels` e
  `toggle_typing_status` contra a versão do seu Chatwoot antes de ir a produção.
- **Olist Tiny v3.** Os nomes de campo da resposta (`itens`, `transportador.
  codigoRastreamento`, `notaFiscal`, `/estoque/{id}`) foram escritos a partir da
  documentação pública e **precisam ser conferidos contra a sua conta** — a
  estrutura varia por módulo contratado. Toda a leitura do ERP está isolada em
  `src/olist/client.ts`; corrigir um nome de campo não toca no resto do agente.
- **Shopify.** A versão `2026-07` é a estável atual da Admin API. As queries usam
  campos estáveis (`orders`, `products`, `fulfillments`).

Recomendação: rodar uma semana em uma inbox de teste, ou com o bot respondendo
apenas fora do horário comercial, antes de colocá-lo na inbox principal.

## Estrutura

```
src/
  config.ts              validação de ambiente (Zod)
  server.ts              rota do webhook, autenticação, fallback de erro
  index.ts               boot e encerramento gracioso
  agent/
    policy.ts            quando responder, horário comercial, identidade
    prompt.ts            prompt de sistema (prefixo cacheado)
    knowledge.ts         carrega knowledge/politicas.md
    tools.ts             definições, titularidade do pedido, execução
    run.ts               laço agêntico
    handler.ts           orquestração, entrega e handoff
  chatwoot/              cliente da API + tipos do webhook
  shopify/               cliente GraphQL Admin
  olist/                 cliente API v3 + OAuth com rotação de refresh token
  conversation/
    history.ts           histórico do Chatwoot → mensagens da API
    scheduler.ts         agrupamento e trava por conversa
knowledge/politicas.md   ← preencher: políticas da loja
scripts/olist-consent.mjs  consentimento OAuth inicial (roda uma vez)
Dockerfile               build multi-stage, roda como usuário sem privilégio
.dockerignore            mantém .env e node_modules fora do contexto de build
docker-compose.yml       deploy em VPS própria, local, ou Coolify via Compose
```
