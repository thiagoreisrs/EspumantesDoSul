import type { Config } from "../config.js";
import type { ChatwootConversation, ChatwootMessage } from "./types.js";
import { HttpError, fetchJson } from "../util/http.js";

/**
 * Cliente da Application API do Chatwoot (v1), autenticado com o token de um
 * Agent Bot. Referência: {baseUrl}/api/v1/accounts/{accountId}/...
 */
export class ChatwootClient {
  private readonly base: string;

  constructor(private readonly cfg: Config) {
    this.base = `${cfg.CHATWOOT_BASE_URL.replace(/\/+$/, "")}/api/v1/accounts/${cfg.CHATWOOT_ACCOUNT_ID}`;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      api_access_token: this.cfg.CHATWOOT_BOT_TOKEN,
    };
  }

  /** Envia uma mensagem visível ao cliente no WhatsApp. */
  async sendMessage(conversationId: number, content: string): Promise<ChatwootMessage> {
    return fetchJson<ChatwootMessage>(`${this.base}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content, message_type: "outgoing", private: false }),
    });
  }

  /** Nota interna: aparece só para a equipe, nunca para o cliente. */
  async sendPrivateNote(conversationId: number, content: string): Promise<ChatwootMessage> {
    return fetchJson<ChatwootMessage>(`${this.base}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content, message_type: "outgoing", private: true }),
    });
  }

  async getConversation(conversationId: number): Promise<ChatwootConversation> {
    return fetchJson<ChatwootConversation>(`${this.base}/conversations/${conversationId}`, {
      method: "GET",
      headers: this.headers(),
    });
  }

  async listMessages(conversationId: number): Promise<ChatwootMessage[]> {
    const body = await fetchJson<{ payload?: ChatwootMessage[] } | ChatwootMessage[]>(
      `${this.base}/conversations/${conversationId}/messages`,
      { method: "GET", headers: this.headers() },
    );
    if (Array.isArray(body)) return body;
    return body.payload ?? [];
  }

  /**
   * Devolve a conversa para a fila humana. Por convenção do Chatwoot, um agent
   * bot trabalha com a conversa em `pending`; mudar para `open` é o handoff.
   */
  async openForHumans(conversationId: number): Promise<void> {
    await fetchJson(`${this.base}/conversations/${conversationId}/toggle_status`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ status: "open" }),
    });
  }

  async assignTeam(conversationId: number, teamId: number): Promise<void> {
    await fetchJson(`${this.base}/conversations/${conversationId}/assignments`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ team_id: teamId }),
    });
  }

  /**
   * O endpoint de labels do Chatwoot substitui a lista inteira, então lemos as
   * atuais antes de acrescentar. Ignora silenciosamente se o rótulo já existe.
   */
  async addLabel(conversationId: number, label: string): Promise<void> {
    const current = await fetchJson<{ payload?: string[] }>(
      `${this.base}/conversations/${conversationId}/labels`,
      { method: "GET", headers: this.headers() },
    );
    const labels = new Set(current.payload ?? []);
    if (labels.has(label)) return;
    labels.add(label);
    await fetchJson(`${this.base}/conversations/${conversationId}/labels`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ labels: [...labels] }),
    });
  }

  /**
   * Indicador de "digitando" no WhatsApp. É cosmético: se o Chatwoot recusar
   * (versões antigas, conversa já atribuída), seguimos em frente.
   */
  async setTyping(conversationId: number, on: boolean): Promise<void> {
    try {
      await fetchJson(`${this.base}/conversations/${conversationId}/toggle_typing_status`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ typing_status: on ? "on" : "off" }),
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
  }
}
