#!/usr/bin/env node
/**
 * Consentimento OAuth inicial da Olist Tiny (API v3) — roda UMA vez.
 *
 * O agente renova o acesso sozinho com refresh_token, mas o primeiro token só
 * sai de um consentimento no navegador. Este script sobe um servidor local,
 * abre a URL de autorização e troca o código pelo par de tokens.
 *
 * Uso:
 *   OLIST_CLIENT_ID=... OLIST_CLIENT_SECRET=... node scripts/olist-consent.mjs
 *
 * Cadastre http://localhost:8788/callback como URL de redirecionamento no
 * aplicativo criado no painel da Olist antes de rodar.
 */
import { createServer } from "node:http";

const CLIENT_ID = process.env.OLIST_CLIENT_ID;
const CLIENT_SECRET = process.env.OLIST_CLIENT_SECRET;
const PORT = Number(process.env.OLIST_CONSENT_PORT ?? 8788);
const REDIRECT_URI = process.env.OLIST_REDIRECT_URI ?? `http://localhost:${PORT}/callback`;
const REALM = process.env.OLIST_REALM_URL ?? "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Defina OLIST_CLIENT_ID e OLIST_CLIENT_SECRET no ambiente.");
  process.exit(1);
}

const authUrl = new URL(`${REALM}/auth`);
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "openid");

console.log("\nAbra esta URL no navegador e autorize o aplicativo:\n");
console.log(authUrl.toString());
console.log(`\nAguardando o retorno em ${REDIRECT_URI} ...\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end("not found");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Sem 'code' na resposta.");
    return;
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    });
    const response = await fetch(`${REALM}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);

    const tokens = JSON.parse(text);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Autorizado. Pode fechar esta aba e voltar ao terminal.");

    console.log("Tokens obtidos. Coloque no seu .env:\n");
    console.log(`OLIST_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`\n(access_token expira em ${tokens.expires_in}s — o agente renova sozinho.)`);
  } catch (err) {
    res.writeHead(500).end(String(err));
    console.error("Falha ao trocar o código pelo token:", err);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 500);
  }
});

server.listen(PORT);
