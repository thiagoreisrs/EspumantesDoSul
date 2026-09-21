import type { Config } from "../config.js";
import { normalizeMessageType, type ChatwootWebhookEvent } from "../chatwoot/types.js";

export interface GateDecision {
  handle: boolean;
  /** Motivo legível — vai para o log, ajuda a auditar por que o bot ficou calado. */
  reason: string;
}

/**
 * Decide se o agente deve sequer olhar para este evento.
 *
 * A regra estrutural é a convenção de agent bot do Chatwoot: o bot trabalha com
 * a conversa em `pending`; assim que um humano assume, o status vira `open` e o
 * bot se cala sozinho. Isso vale mais do que qualquer heurística de texto,
 * porque dá ao atendente um botão físico para tomar a conversa.
 */
export function shouldHandle(event: ChatwootWebhookEvent, cfg: Config): GateDecision {
  if (event.event !== "message_created") {
    return { handle: false, reason: `evento ignorado: ${event.event ?? "desconhecido"}` };
  }

  const type = normalizeMessageType(event.message_type);
  if (type !== "incoming") {
    return { handle: false, reason: `mensagem não é do cliente (${type ?? "?"})` };
  }

  if (event.private === true) {
    return { handle: false, reason: "nota privada" };
  }

  const conversation = event.conversation;
  if (!conversation?.id) {
    return { handle: false, reason: "payload sem conversa" };
  }

  const inboxId = conversation.inbox_id ?? event.inbox?.id;
  if (cfg.CHATWOOT_INBOX_IDS.length > 0 && (inboxId === undefined || !cfg.CHATWOOT_INBOX_IDS.includes(inboxId))) {
    return { handle: false, reason: `inbox ${inboxId} fora do escopo` };
  }

  const labels = conversation.labels ?? [];
  if (labels.includes(cfg.CHATWOOT_MUTE_LABEL)) {
    return { handle: false, reason: `conversa marcada com "${cfg.CHATWOOT_MUTE_LABEL}"` };
  }

  const status = conversation.status;
  if (status && status !== "pending") {
    return { handle: false, reason: `conversa em "${status}" — humano no comando` };
  }

  if (conversation.meta?.assignee?.id) {
    return { handle: false, reason: "conversa já atribuída a um atendente" };
  }

  const text = (event.content ?? "").trim();
  const attachments = event.attachments ?? [];
  if (!text && attachments.length === 0) {
    return { handle: false, reason: "mensagem vazia" };
  }

  return { handle: true, reason: "ok" };
}

/**
 * Áudio, imagem e documento chegam muito no WhatsApp de um e-commerce de vinho
 * (foto do rótulo, print do boleto, áudio com a dúvida). O agente não processa
 * esses formatos, então entregamos direto para um humano em vez de responder
 * ao texto vazio que os acompanha.
 */
export function hasUnsupportedAttachment(event: ChatwootWebhookEvent): boolean {
  const attachments = event.attachments ?? [];
  if (attachments.length === 0) return false;
  const supported = new Set(["image"]); // imagem entra como contexto textual mínimo
  return attachments.some((a) => !a.file_type || !supported.has(a.file_type));
}

export function isBusinessHours(now: Date, cfg: Config): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: cfg.TIMEZONE,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
  if (weekdayIndex === -1 || !cfg.BUSINESS_DAYS.includes(weekdayIndex)) return false;
  return hour >= cfg.BUSINESS_HOURS_START && hour < cfg.BUSINESS_HOURS_END;
}

// --------------------------------------------------------------- identidade --

/** Reduz um telefone a dígitos e descarta o DDI 55, para comparar BR com BR. */
export function normalizePhone(value: string | null | undefined): string {
  if (!value) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.length > 11 && digits.startsWith("55")) digits = digits.slice(2);
  // Celular brasileiro ganhou o nono dígito; compara pelos 8 finais, que são
  // estáveis entre o formato antigo e o novo.
  return digits.slice(-8);
}

export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na.length >= 8 && na === nb;
}

export function emailsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function normalizeCpf(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}
