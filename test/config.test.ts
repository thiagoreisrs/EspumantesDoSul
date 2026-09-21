import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CHATWOOT_BASE_URL: "https://chat.example.com",
  CHATWOOT_ACCOUNT_ID: "1",
  CHATWOOT_BOT_TOKEN: "bot-token",
  CHATWOOT_WEBHOOK_SECRET: "0123456789abcdef0123456789abcdef",
  SHOPIFY_SHOP_DOMAIN: "loja.myshopify.com",
  SHOPIFY_ADMIN_TOKEN: "shpat_test",
  OLIST_ENABLED: "false",
};

const semA = (chave: string) => {
  const env = { ...BASE };
  delete env[chave];
  return env;
};

describe("loadConfig", () => {
  it("aceita uma configuração completa", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.CHATWOOT_ACCOUNT_ID).toBe(1);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.OLIST_ENABLED).toBe(false);
  });

  it("diz 'Required' — e não 'nan' — quando um inteiro obrigatório falta", () => {
    // Regressão: com z.coerce.number() o log do deploy dizia
    // "Expected number, received nan", mandando quem lê caçar valor malformado
    // quando a variável simplesmente não existia.
    expect(() => loadConfig(semA("CHATWOOT_ACCOUNT_ID"))).toThrowError(/CHATWOOT_ACCOUNT_ID: Required/);
    expect(() => loadConfig(semA("CHATWOOT_ACCOUNT_ID"))).not.toThrowError(/nan/i);
  });

  it("trata string vazia como ausente num inteiro obrigatório", () => {
    expect(() => loadConfig({ ...BASE, CHATWOOT_ACCOUNT_ID: "" })).toThrowError(/CHATWOOT_ACCOUNT_ID: Required/);
  });

  it("distingue valor malformado de valor ausente", () => {
    expect(() => loadConfig({ ...BASE, CHATWOOT_ACCOUNT_ID: "abc" })).toThrowError(/Esperado um número inteiro/);
  });

  it("não derruba a subida com variável opcional cadastrada em branco", () => {
    // O painel do Coolify entrega variável criada e não preenchida como "".
    const cfg = loadConfig({ ...BASE, CHATWOOT_HANDOFF_TEAM_ID: "" });
    expect(cfg.CHATWOOT_HANDOFF_TEAM_ID).toBeUndefined();
  });

  it("deixa o default valer quando a variável vem em branco", () => {
    const cfg = loadConfig({ ...BASE, PORT: "", LOG_LEVEL: "" as never, CHATWOOT_INBOX_IDS: "" });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.LOG_LEVEL).toBe("info");
    expect(cfg.CHATWOOT_INBOX_IDS).toEqual([]);
  });

  it("lista todos os segredos faltantes de uma vez", () => {
    let msg = "";
    try {
      loadConfig({ NODE_ENV: "test" });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    for (const chave of [
      "ANTHROPIC_API_KEY",
      "CHATWOOT_BASE_URL",
      "CHATWOOT_ACCOUNT_ID",
      "CHATWOOT_BOT_TOKEN",
      "CHATWOOT_WEBHOOK_SECRET",
      "SHOPIFY_SHOP_DOMAIN",
      "SHOPIFY_ADMIN_TOKEN",
    ]) {
      expect(msg).toContain(chave);
    }
  });

  it("exige credenciais da Olist quando o ERP está ligado", () => {
    expect(() => loadConfig({ ...BASE, OLIST_ENABLED: "true" })).toThrowError(/OLIST_CLIENT_ID/);
  });
});
