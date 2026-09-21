import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import { ChatwootClient } from "./chatwoot/client.js";
import { ShopifyClient } from "./shopify/client.js";
import { OlistClient } from "./olist/client.js";
import { ConversationScheduler } from "./conversation/scheduler.js";
import { handleConversation, handoffUnsupported, type HandlerDeps } from "./agent/handler.js";
import { hasUnsupportedAttachment, isBusinessHours, shouldHandle } from "./agent/policy.js";
import type { ChatwootWebhookEvent } from "./chatwoot/types.js";

function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function buildServer(cfg: Config): { app: FastifyInstance; scheduler: ConversationScheduler } {
  const app = Fastify({ logger: { level: cfg.LOG_LEVEL } });

  const anthropic = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const chatwoot = new ChatwootClient(cfg);
  const shopify = new ShopifyClient(cfg);
  const olist = cfg.OLIST_ENABLED ? new OlistClient(cfg) : null;

  const deps: HandlerDeps = {
    cfg,
    anthropic,
    chatwoot,
    shopify,
    olist,
    log: (level, msg, extra) => app.log[level](extra ?? {}, msg),
  };

  const scheduler = new ConversationScheduler(
    cfg.DEBOUNCE_MS,
    (conversationId) => handleConversation(conversationId, deps),
    (conversationId, err) => {
      app.log.error({ conversationId, err }, "falha ao atender conversa");
      // Uma exceção não pode virar silêncio para o cliente: devolvemos a
      // conversa para a fila humana e deixamos o rastro na nota interna.
      void chatwoot
        .sendPrivateNote(
          conversationId,
          `🤖 Erro interno no agente: ${err instanceof Error ? err.message : String(err)}\nConversa devolvida para atendimento humano.`,
        )
        .then(() => chatwoot.addLabel(conversationId, cfg.CHATWOOT_ESCALATION_LABEL))
        .then(() => chatwoot.openForHumans(conversationId))
        .catch((e) => app.log.error({ conversationId, err: e }, "falha também no fallback de escalonamento"));
    },
  );

  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  /**
   * Endpoint do Agent Bot do Chatwoot.
   *
   * O Chatwoot não assina os webhooks de agent bot, então a autenticação é um
   * segredo compartilhado no path. Configure a URL do bot como:
   *   https://seu-host/webhooks/chatwoot/<CHATWOOT_WEBHOOK_SECRET>
   */
  app.post<{ Params: { secret: string }; Body: ChatwootWebhookEvent }>(
    "/webhooks/chatwoot/:secret",
    async (request, reply) => {
      if (!secretsMatch(request.params.secret, cfg.CHATWOOT_WEBHOOK_SECRET)) {
        app.log.warn({ ip: request.ip }, "webhook com segredo inválido");
        return reply.code(401).send({ error: "unauthorized" });
      }

      const event = request.body ?? {};
      const decision = shouldHandle(event, cfg);
      const conversationId = event.conversation?.id;

      if (!decision.handle || !conversationId) {
        app.log.debug({ conversationId, motivo: decision.reason }, "evento ignorado");
        // 200 sempre: um não-200 faz o Chatwoot reenfileirar e reentregar.
        return reply.code(200).send({ ignored: true, reason: decision.reason });
      }

      if (hasUnsupportedAttachment(event)) {
        void handoffUnsupported(conversationId, deps, isBusinessHours(new Date(), cfg)).catch((err) =>
          app.log.error({ conversationId, err }, "falha no handoff de anexo"),
        );
        return reply.code(200).send({ handedOff: true });
      }

      // Responder rápido e processar fora do ciclo da requisição: o Chatwoot
      // tem timeout curto no webhook e o agente pode levar segundos.
      scheduler.schedule(conversationId);
      return reply.code(202).send({ scheduled: true });
    },
  );

  return { app, scheduler };
}
