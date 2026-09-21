import { readFile, writeFile } from "node:fs/promises";
import type { Config } from "../config.js";
import { HttpError, fetchJson } from "../util/http.js";

export interface OlistPedidoResumo {
  id: number | string;
  numeroPedido?: number | string;
  situacao?: string | number;
  dataCriacao?: string;
  dataPrevista?: string;
  valorTotal?: number;
  cliente?: { nome?: string; email?: string; cpfCnpj?: string; fone?: string };
}

export interface OlistPedidoDetalhe extends OlistPedidoResumo {
  transportador?: {
    nome?: string;
    formaEnvio?: { nome?: string };
    codigoRastreamento?: string;
    urlRastreamento?: string;
  };
  itens?: Array<{ descricao?: string; quantidade?: number; codigo?: string }>;
  notaFiscal?: { numero?: string; chaveAcesso?: string; dataEmissao?: string; linkDanfe?: string };
}

interface TokenState {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}

/**
 * Cliente da API v3 do Olist Tiny ERP.
 *
 * Autenticação: OAuth2 (Keycloak). Usamos `grant_type=refresh_token`, porque o
 * fluxo de consentimento inicial é manual e roda uma vez só (ver README).
 */
export class OlistClient {
  private state: TokenState | null = null;
  private refreshing: Promise<TokenState> | null = null;

  constructor(private readonly cfg: Config) {}

  // ---------------------------------------------------------------- tokens --

  private async loadPersistedRefreshToken(): Promise<string> {
    try {
      const raw = await readFile(this.cfg.OLIST_TOKEN_STORE, "utf8");
      const parsed = JSON.parse(raw) as { refreshToken?: string };
      if (parsed.refreshToken) return parsed.refreshToken;
    } catch {
      // Sem arquivo ainda (primeiro boot) ou conteúdo inválido: cai no env.
    }
    return this.cfg.OLIST_REFRESH_TOKEN;
  }

  private async persistRefreshToken(refreshToken: string): Promise<void> {
    try {
      await writeFile(
        this.cfg.OLIST_TOKEN_STORE,
        JSON.stringify({ refreshToken, updatedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } catch {
      // Disco somente-leitura (container imutável): seguimos com o token em
      // memória. O README explica como montar um volume para evitar isso.
    }
  }

  private async refresh(): Promise<TokenState> {
    const refreshToken = this.state?.refreshToken ?? (await this.loadPersistedRefreshToken());
    if (!refreshToken) throw new Error("Olist: refresh token ausente.");

    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.cfg.OLIST_CLIENT_ID,
      client_secret: this.cfg.OLIST_CLIENT_SECRET,
      refresh_token: refreshToken,
    });

    const body = await fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    }>(this.cfg.OLIST_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const next: TokenState = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? refreshToken,
      // 60s de folga para não usar um token que expira em trânsito.
      expiresAt: Date.now() + Math.max(0, body.expires_in - 60) * 1000,
    };
    this.state = next;
    if (body.refresh_token && body.refresh_token !== refreshToken) {
      await this.persistRefreshToken(body.refresh_token);
    }
    return next;
  }

  /** Renovações concorrentes compartilham a mesma promessa. */
  private async accessToken(): Promise<string> {
    if (this.state && this.state.expiresAt > Date.now()) return this.state.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return (await this.refreshing).accessToken;
  }

  // ------------------------------------------------------------------- api --

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${this.cfg.OLIST_API_BASE_URL.replace(/\/+$/, "")}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const call = async (token: string) =>
      fetchJson<T>(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });

    try {
      return await call(await this.accessToken());
    } catch (err) {
      // Token revogado do lado da Olist: força uma renovação e tenta uma vez.
      if (err instanceof HttpError && err.status === 401) {
        this.state = null;
        return call(await this.accessToken());
      }
      throw err;
    }
  }

  async buscarPedidos(params: { numero?: string; cpfCnpj?: string; nomeCliente?: string }): Promise<OlistPedidoResumo[]> {
    const body = await this.get<{ itens?: OlistPedidoResumo[] }>("/pedidos", {
      numero: params.numero,
      cpfCnpj: params.cpfCnpj,
      nomeCliente: params.nomeCliente,
      limit: 10,
    });
    return body.itens ?? [];
  }

  async obterPedido(id: number | string): Promise<OlistPedidoDetalhe> {
    return this.get<OlistPedidoDetalhe>(`/pedidos/${encodeURIComponent(String(id))}`);
  }

  async buscarProdutos(termo: string): Promise<Array<{ id: number | string; sku?: string; descricao?: string; saldo?: number }>> {
    const body = await this.get<{ itens?: Array<{ id: number | string; sku?: string; descricao?: string; saldo?: number }> }>(
      "/produtos",
      { nome: termo, limit: 10 },
    );
    return body.itens ?? [];
  }

  async obterEstoque(idProduto: number | string): Promise<{ saldo?: number; saldoReservado?: number }> {
    return this.get(`/estoque/${encodeURIComponent(String(idProduto))}`);
  }
}
