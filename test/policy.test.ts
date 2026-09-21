import { describe, expect, it } from "vitest";
import {
  hasUnsupportedAttachment,
  isBusinessHours,
  normalizePhone,
  phonesMatch,
  shouldHandle,
} from "../src/agent/policy.js";
import type { ChatwootWebhookEvent } from "../src/chatwoot/types.js";
import { testConfig } from "./helpers.js";

const cfg = testConfig();

function evento(overrides: Partial<ChatwootWebhookEvent> = {}): ChatwootWebhookEvent {
  return {
    event: "message_created",
    message_type: "incoming",
    content: "oi, cadê meu pedido?",
    conversation: { id: 42, inbox_id: 7, status: "pending", labels: [], meta: {} },
    ...overrides,
  };
}

describe("shouldHandle", () => {
  it("atende mensagem de cliente numa conversa pendente", () => {
    expect(shouldHandle(evento(), cfg).handle).toBe(true);
  });

  it("ignora mensagem enviada pela própria loja", () => {
    expect(shouldHandle(evento({ message_type: "outgoing" }), cfg).handle).toBe(false);
  });

  it("aceita message_type como inteiro do enum do Rails", () => {
    expect(shouldHandle(evento({ message_type: 0 }), cfg).handle).toBe(true);
    expect(shouldHandle(evento({ message_type: 1 }), cfg).handle).toBe(false);
  });

  it("cala o bot quando um humano assume a conversa", () => {
    const aberta = evento({ conversation: { id: 42, status: "open", labels: [], meta: {} } });
    expect(shouldHandle(aberta, cfg)).toMatchObject({ handle: false });

    const atribuida = evento({
      conversation: { id: 42, status: "pending", labels: [], meta: { assignee: { id: 9 } } },
    });
    expect(shouldHandle(atribuida, cfg).handle).toBe(false);
  });

  it("respeita o rótulo de silenciamento", () => {
    const mudo = evento({ conversation: { id: 42, status: "pending", labels: ["bot-pausado"], meta: {} } });
    expect(shouldHandle(mudo, cfg).handle).toBe(false);
  });

  it("ignora nota privada e mensagem vazia", () => {
    expect(shouldHandle(evento({ private: true }), cfg).handle).toBe(false);
    expect(shouldHandle(evento({ content: "   " }), cfg).handle).toBe(false);
  });

  it("filtra por inbox quando há escopo configurado", () => {
    const restrito = testConfig({ CHATWOOT_INBOX_IDS: "7,8" });
    expect(shouldHandle(evento(), restrito).handle).toBe(true);

    const outra = evento({ conversation: { id: 42, inbox_id: 99, status: "pending", labels: [], meta: {} } });
    expect(shouldHandle(outra, restrito).handle).toBe(false);
  });

  it("ignora eventos que não são criação de mensagem", () => {
    expect(shouldHandle(evento({ event: "conversation_updated" }), cfg).handle).toBe(false);
  });
});

describe("hasUnsupportedAttachment", () => {
  it("encaminha áudio direto para humano", () => {
    expect(hasUnsupportedAttachment(evento({ attachments: [{ file_type: "audio" }] }))).toBe(true);
  });

  it("aceita imagem e mensagem sem anexo", () => {
    expect(hasUnsupportedAttachment(evento({ attachments: [{ file_type: "image" }] }))).toBe(false);
    expect(hasUnsupportedAttachment(evento())).toBe(false);
  });
});

describe("isBusinessHours", () => {
  // 2026-09-21 é uma segunda-feira.
  it("reconhece horário comercial em dia útil", () => {
    expect(isBusinessHours(new Date("2026-09-21T13:00:00Z"), cfg)).toBe(true); // 10h em SP
  });

  it("rejeita madrugada e fim de semana", () => {
    expect(isBusinessHours(new Date("2026-09-21T05:00:00Z"), cfg)).toBe(false); // 2h em SP
    expect(isBusinessHours(new Date("2026-09-20T13:00:00Z"), cfg)).toBe(false); // domingo
  });
});

describe("normalizePhone / phonesMatch", () => {
  it("compara telefones brasileiros com e sem DDI e nono dígito", () => {
    expect(phonesMatch("+55 51 99999-8888", "5199998888")).toBe(true);
    expect(phonesMatch("+55 (51) 9999-8888", "+555199998888")).toBe(true);
    expect(phonesMatch("+55 51 99999-8888", "+55 51 91111-2222")).toBe(false);
  });

  it("não considera vazio como igual", () => {
    expect(phonesMatch(null, null)).toBe(false);
    expect(phonesMatch("", "")).toBe(false);
    expect(normalizePhone(undefined)).toBe("");
  });
});
