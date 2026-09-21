import { z } from "zod";

/**
 * Inteiro vindo do ambiente.
 *
 * `z.coerce.number()` converte ausência em NaN, e o erro sai como
 * "Expected number, received nan" — que manda quem está lendo o log do deploy
 * caçar um valor malformado quando o problema é a variável não existir. Este
 * helper preserva a distinção entre "não informado" e "informado errado".
 */
function intEnv(opts: { min?: number; optional?: boolean } = {}) {
  const { min = 1, optional = false } = opts;
  const base = z
    .number({ required_error: "Required", invalid_type_error: "Esperado um número inteiro" })
    .int("Esperado um número inteiro")
    .min(min, `Esperado um número inteiro maior ou igual a ${min}`);
  return z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? undefined : Number(v)),
    optional ? base.optional() : base,
  );
}

/**
 * Toda a configuração do agente vem de variáveis de ambiente e é validada na
 * subida do processo. Falhar aqui é melhor do que descobrir um segredo ausente
 * no meio de um atendimento.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // ---- Claude ----
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default("claude-opus-5"),
  // Rotas de chat raramente pagam o custo de effort alto; "medium" é o ponto
  // de equilíbrio para atendimento. Suba para "high" se a qualidade cair.
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().default(2000),
  /** Teto de idas e voltas de ferramenta por mensagem do cliente. */
  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(6),

  // ---- Chatwoot ----
  CHATWOOT_BASE_URL: z.string().url(),
  CHATWOOT_ACCOUNT_ID: intEnv(),
  /** Token de acesso de um Agent Bot (Configurações > Agent Bots). */
  CHATWOOT_BOT_TOKEN: z.string().min(1),
  /**
   * Segredo compartilhado exigido no webhook. O Chatwoot NÃO assina os webhooks
   * de agent bot, então protegemos a rota com um token próprio na URL.
   */
  CHATWOOT_WEBHOOK_SECRET: z.string().min(16),
  /** Só atende conversas destas inboxes (IDs separados por vírgula). Vazio = todas. */
  CHATWOOT_INBOX_IDS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number),
    ),
  /** Time para onde a conversa é encaminhada ao escalar. Vazio = só abre a conversa. */
  CHATWOOT_HANDOFF_TEAM_ID: intEnv({ optional: true }),
  /** Rótulo aplicado em conversas escaladas pelo bot. */
  CHATWOOT_ESCALATION_LABEL: z.string().default("escalado-bot"),
  /** Rótulo que, se presente na conversa, silencia o bot permanentemente. */
  CHATWOOT_MUTE_LABEL: z.string().default("bot-pausado"),

  // ---- Shopify ----
  SHOPIFY_SHOP_DOMAIN: z.string().min(1), // ex.: espumantesdosul.myshopify.com
  SHOPIFY_ADMIN_TOKEN: z.string().min(1), // shpat_...
  SHOPIFY_API_VERSION: z.string().default("2026-07"),

  // ---- Olist Tiny ERP (API v3, OAuth2) ----
  OLIST_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  OLIST_API_BASE_URL: z.string().url().default("https://api.tiny.com.br/public-api/v3"),
  OLIST_TOKEN_URL: z
    .string()
    .url()
    .default("https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token"),
  OLIST_CLIENT_ID: z.string().default(""),
  OLIST_CLIENT_SECRET: z.string().default(""),
  /** Refresh token obtido no consentimento OAuth inicial (ver README). */
  OLIST_REFRESH_TOKEN: z.string().default(""),
  /**
   * O Keycloak da Olist rotaciona o refresh token a cada renovação. Guardamos o
   * token corrente em disco para sobreviver a restart; sem isso o agente perde
   * o acesso ao ERP no primeiro deploy após a validade do refresh original.
   */
  OLIST_TOKEN_STORE: z.string().default("./.olist-token.json"),

  // ---- Comportamento do atendimento ----
  /**
   * Janela de agrupamento: no WhatsApp o cliente manda 3 mensagens curtas
   * seguidas. Esperamos este tempo antes de acionar o agente, para responder
   * a intenção completa em vez de a cada fragmento.
   */
  DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(8000),
  /** Quantas mensagens anteriores da conversa entram no contexto do modelo. */
  HISTORY_LIMIT: z.coerce.number().int().positive().default(20),
  /** Fuso usado para calcular horário comercial. */
  TIMEZONE: z.string().default("America/Sao_Paulo"),
  /** Horário comercial, hora local, formato 24h. */
  BUSINESS_HOURS_START: z.coerce.number().int().min(0).max(23).default(9),
  BUSINESS_HOURS_END: z.coerce.number().int().min(1).max(24).default(18),
  /** Dias úteis: 0=domingo ... 6=sábado. */
  BUSINESS_DAYS: z
    .string()
    .default("1,2,3,4,5")
    .transform((v) => v.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

/**
 * Painéis de deploy como o Coolify entregam variável cadastrada e não
 * preenchida como string vazia, não como ausente. Sem isto, `PORT=""` vira 0 e
 * `CHATWOOT_HANDOFF_TEAM_ID=""` derruba a subida — em vez de simplesmente
 * caírem no default ou em "não informado".
 */
function dropEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== "") out[key] = value;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(dropEmpty(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.OLIST_ENABLED && (!cfg.OLIST_CLIENT_ID || !cfg.OLIST_CLIENT_SECRET || !cfg.OLIST_REFRESH_TOKEN)) {
    throw new Error(
      "OLIST_ENABLED=true exige OLIST_CLIENT_ID, OLIST_CLIENT_SECRET e OLIST_REFRESH_TOKEN. " +
        "Use OLIST_ENABLED=false para subir sem o ERP.",
    );
  }
  return cfg;
}

export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
