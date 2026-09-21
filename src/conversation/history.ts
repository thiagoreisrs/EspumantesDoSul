import type Anthropic from "@anthropic-ai/sdk";
import { normalizeMessageType, type ChatwootMessage } from "../chatwoot/types.js";

/**
 * Converte o histórico do Chatwoot em mensagens para a API.
 *
 * Regras:
 *  - nota privada e evento de sistema ficam de fora (o cliente nunca os viu);
 *  - incoming vira `user`, outgoing vira `assistant`;
 *  - mensagens consecutivas do mesmo papel são fundidas, porque a API espera
 *    alternância e o WhatsApp produz rajadas de mensagens curtas;
 *  - o histórico sempre começa em `user`.
 */
export function buildHistory(messages: ChatwootMessage[], limit: number): Anthropic.Beta.BetaMessageParam[] {
  const relevant = messages
    .filter((m) => m.private !== true)
    .filter((m) => {
      const type = normalizeMessageType(m.message_type);
      return type === "incoming" || type === "outgoing";
    })
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0);

  const recent = relevant.slice(-limit);

  const merged: Anthropic.Beta.BetaMessageParam[] = [];
  for (const message of recent) {
    const role: "user" | "assistant" = normalizeMessageType(message.message_type) === "incoming" ? "user" : "assistant";
    const text = (message.content ?? "").trim();
    const last = merged[merged.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content = `${last.content}\n${text}`;
    } else {
      merged.push({ role, content: text });
    }
  }

  while (merged.length > 0 && merged[0]!.role !== "user") merged.shift();
  return merged;
}

/**
 * Contexto volátil (nome do cliente, horário, id da conversa) vai aqui, depois
 * do prefixo cacheado, e não no prompt de sistema.
 */
export function buildContextBlock(params: {
  nomeCliente?: string | null;
  telefone?: string | null;
  email?: string | null;
  dentroDoHorario: boolean;
  agoraLocal: string;
}): string {
  const linhas = [
    `Data e hora agora: ${params.agoraLocal}`,
    `Atendimento humano disponível agora: ${params.dentroDoHorario ? "sim" : "não (fora do horário comercial)"}`,
    `Nome do contato no WhatsApp: ${params.nomeCliente || "não informado"}`,
    `Telefone do contato: ${params.telefone || "não informado"}`,
    `E-mail cadastrado no contato: ${params.email || "não informado"}`,
  ];
  return `<contexto_atendimento>\n${linhas.join("\n")}\n</contexto_atendimento>`;
}
