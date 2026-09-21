/**
 * Subconjunto do payload de webhook do Chatwoot que realmente consumimos.
 * O Chatwoot envia bem mais campos; tipamos só o que lemos, e tudo que vem
 * de fora é tratado como não confiável até ser validado.
 */

export type ChatwootMessageType = "incoming" | "outgoing" | "activity" | "template";
export type ChatwootConversationStatus = "open" | "resolved" | "pending" | "snoozed";

export interface ChatwootContact {
  id?: number;
  name?: string | null;
  email?: string | null;
  phone_number?: string | null;
  identifier?: string | null;
}

export interface ChatwootConversationMeta {
  sender?: ChatwootContact;
  assignee?: { id?: number; name?: string } | null;
}

export interface ChatwootConversation {
  id: number;
  inbox_id?: number;
  status?: ChatwootConversationStatus;
  labels?: string[];
  meta?: ChatwootConversationMeta;
  messages?: ChatwootMessage[];
}

export interface ChatwootMessage {
  id: number;
  content?: string | null;
  message_type?: ChatwootMessageType | number;
  private?: boolean;
  created_at?: number | string;
  sender?: (ChatwootContact & { type?: string }) | null;
  attachments?: Array<{ file_type?: string; data_url?: string }>;
}

export interface ChatwootWebhookEvent {
  event?: string;
  id?: number;
  content?: string | null;
  message_type?: ChatwootMessageType | number;
  private?: boolean;
  inbox?: { id?: number; name?: string };
  conversation?: ChatwootConversation;
  sender?: (ChatwootContact & { type?: string }) | null;
  account?: { id?: number };
  attachments?: Array<{ file_type?: string; data_url?: string }>;
}

/**
 * O Chatwoot é inconsistente: em alguns eventos `message_type` chega como
 * string ("incoming") e em outros como inteiro do enum do Rails (0=incoming,
 * 1=outgoing, 2=activity, 3=template). Normalizamos para string.
 */
export function normalizeMessageType(value: unknown): ChatwootMessageType | undefined {
  if (typeof value === "string") {
    if (value === "incoming" || value === "outgoing" || value === "activity" || value === "template") {
      return value;
    }
    return undefined;
  }
  if (typeof value === "number") {
    return (["incoming", "outgoing", "activity", "template"] as const)[value];
  }
  return undefined;
}
