import { loadConfig, type Config } from "../src/config.js";

const BASE_ENV: NodeJS.ProcessEnv = {
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

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({ ...BASE_ENV, ...overrides });
}
