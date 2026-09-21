import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { ChatwootClient } from "../chatwoot/client.js";
import type { ChatwootWebhookEvent } from "../chatwoot/types.js";
import type { OlistClient } from "../olist/client.js";
import type { ShopifyClient } from "../shopify/client.js";
import { buildContextBlock, buildHistory } from "../conversation/history.js";
import { hasUnsupportedAttachment, isBusinessHours } from "./policy.js";
import { runAgent } from "./run.js";
import type { AgentOutcome, MotivoEscalonamento } from "./tools.js";

export interface HandlerDeps {
  cfg: Config;
  anthropic: Anthropic;
  chatwoot: ChatwootClient;
  shopify: ShopifyClient;
  olist: OlistClient | null;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

const MOTIVO_LEGIVEL: Record<MotivoEscalonamento, string> = {
  reclamacao: "Reclamação",
  troca_devolucao_estorno: "Troca / devolução / estorno",
  produto_avariado: "Produto avariado",
  negociacao_desconto: "Negociação ou desconto",
  pedido_explicito_humano: "Cliente pediu atendente",
  dado_sensivel_pagamento: "Assunto de pagamento",
  suspeita_menor_idade: "Suspeita de menor de idade",
  fora_do_escopo: "Fora do escopo do bot",
  baixa_confianca: "Baixa confiança do agente",
  falha_tecnica: "Falha técnica",
};

/**
 * Orquestra um atendimento: junta contexto, roda o agente, entrega a resposta e
 * executa o handoff quando necessário.
 */
export async function handleConversation(conversationId: number, deps: HandlerDeps): Promise<void> {
  const { cfg, chatwoot, log } = deps;

  const conversation = await chatwoot.getConversation(conversationId);

  // O estado pode ter mudado durante o debounce — um atendente pode ter
  // assumido a conversa nesses segundos. Revalidamos antes de falar.
  if (conversation.status && conversation.status !== "pending") {
    log("info", "conversa deixou de estar pendente durante o debounce", { conversationId, status: conversation.status });
    return;
  }
  if ((conversation.labels ?? []).includes(cfg.CHATWOOT_MUTE_LABEL)) {
    log("info", "conversa silenciada por rótulo", { conversationId });
    return;
  }

  const contact = conversation.meta?.sender ?? {};
  const messages = await chatwoot.listMessages(conversationId);
  const history = buildHistory(messages, cfg.HISTORY_LIMIT);

  if (history.length === 0) {
    log("info", "sem histórico utilizável", { conversationId });
    return;
  }

  const now = new Date();
  const dentroDoHorario = isBusinessHours(now, cfg);
  const contexto = buildContextBlock({
    nomeCliente: contact.name,
    telefone: contact.phone_number,
    email: contact.email,
    dentroDoHorario,
    agoraLocal: now.toLocaleString("pt-BR", { timeZone: cfg.TIMEZONE }),
  });

  // O bloco de contexto entra colado na última mensagem do cliente, depois do
  // prefixo cacheado, para não invalidar o cache do prompt de sistema.
  const last = history[history.length - 1]!;
  const withContext: Anthropic.Beta.BetaMessageParam[] = [
    ...history.slice(0, -1),
    { role: last.role, content: `${contexto}\n\n${typeof last.content === "string" ? last.content : ""}`.trim() },
  ];

  await chatwoot.setTyping(conversationId, true);
  try {
    const result = await runAgent({
      client: deps.anthropic,
      cfg,
      messages: withContext,
      toolContext: {
        shopify: deps.shopify,
        olist: deps.olist,
        contact: { name: contact.name, phone: contact.phone_number, email: contact.email },
      },
      log: (msg, extra) => log("info", msg, { conversationId, ...extra }),
    });

    log("info", "agente concluiu", {
      conversationId,
      iteracoes: result.iterations,
      ferramentas: result.outcome.toolsUsed,
      escalou: Boolean(result.outcome.escalate),
      tokens_entrada: result.usage.input,
      tokens_saida: result.usage.output,
      tokens_cache: result.usage.cacheRead,
    });

    await deliver(conversationId, result.reply, result.outcome, dentroDoHorario, deps);
  } finally {
    await chatwoot.setTyping(conversationId, false);
  }
}

async function deliver(
  conversationId: number,
  reply: string | null,
  outcome: AgentOutcome,
  dentroDoHorario: boolean,
  deps: HandlerDeps,
): Promise<void> {
  const { cfg, chatwoot } = deps;

  if (outcome.stayQuiet && !outcome.escalate) {
    await chatwoot.sendPrivateNote(
      conversationId,
      `🤖 O agente optou por não responder.\nMotivo: ${outcome.stayQuiet.motivo}`,
    );
    return;
  }

  if (outcome.escalate) {
    const { motivo, resumo } = outcome.escalate;
    const mensagemCliente =
      reply?.trim() ||
      (dentroDoHorario
        ? "Vou passar seu atendimento para uma pessoa da nossa equipe, que já continua com você por aqui."
        : "Vou passar seu atendimento para a nossa equipe. Estamos fora do horário de atendimento agora, mas retornamos no próximo dia útil por aqui mesmo.");

    await chatwoot.sendMessage(conversationId, mensagemCliente);
    await chatwoot.sendPrivateNote(
      conversationId,
      [
        "🤖 *Encaminhado pelo agente*",
        `Motivo: ${MOTIVO_LEGIVEL[motivo] ?? motivo}`,
        `Ferramentas consultadas: ${outcome.toolsUsed.length ? outcome.toolsUsed.join(", ") : "nenhuma"}`,
        "",
        resumo,
      ].join("\n"),
    );

    await chatwoot.addLabel(conversationId, cfg.CHATWOOT_ESCALATION_LABEL);
    if (cfg.CHATWOOT_HANDOFF_TEAM_ID) {
      await chatwoot.assignTeam(conversationId, cfg.CHATWOOT_HANDOFF_TEAM_ID);
    }
    // Por último: mudar para `open` é o que tira a conversa do bot.
    await chatwoot.openForHumans(conversationId);
    return;
  }

  if (!reply?.trim()) {
    // O agente terminou sem texto e sem escalar. Isso não deveria acontecer;
    // tratamos como falha e entregamos para um humano em vez de sumir.
    deps.log("warn", "agente terminou sem resposta e sem escalonamento", { conversationId });
    await chatwoot.sendPrivateNote(
      conversationId,
      "🤖 O agente terminou sem produzir resposta. Conversa devolvida para atendimento humano.",
    );
    await chatwoot.addLabel(conversationId, cfg.CHATWOOT_ESCALATION_LABEL);
    await chatwoot.openForHumans(conversationId);
    return;
  }

  await chatwoot.sendMessage(conversationId, reply.trim());
}

/**
 * Handoff imediato, sem passar pelo modelo. Usado para áudio, documento e
 * outros formatos que o agente não lê.
 */
export async function handoffUnsupported(
  conversationId: number,
  deps: HandlerDeps,
  dentroDoHorario: boolean,
): Promise<void> {
  const { cfg, chatwoot } = deps;
  await chatwoot.sendMessage(
    conversationId,
    dentroDoHorario
      ? "Recebi seu arquivo! Vou passar para alguém da equipe dar uma olhada e te responder por aqui."
      : "Recebi seu arquivo! Nossa equipe vê isso no próximo horário de atendimento e te responde por aqui.",
  );
  await chatwoot.sendPrivateNote(
    conversationId,
    "🤖 Mensagem com anexo não suportado (áudio, vídeo ou documento). Encaminhado sem passar pelo agente.",
  );
  await chatwoot.addLabel(conversationId, cfg.CHATWOOT_ESCALATION_LABEL);
  await chatwoot.openForHumans(conversationId);
}

export { hasUnsupportedAttachment };
export type { ChatwootWebhookEvent };
