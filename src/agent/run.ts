import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOL_DEFINITIONS, executeTool, type AgentOutcome, type ToolContext } from "./tools.js";

export interface AgentResult {
  reply: string | null;
  outcome: AgentOutcome;
  iterations: number;
  usage: { input: number; output: number; cacheRead: number };
}

export interface RunOptions {
  client: Anthropic;
  cfg: Config;
  messages: Anthropic.Beta.BetaMessageParam[];
  toolContext: Omit<ToolContext, "outcome">;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Laço agêntico manual.
 *
 * Usamos o laço manual em vez do tool runner do SDK porque este serviço fica na
 * frente de um cliente pagante: precisamos tratar explicitamente `refusal`,
 * `max_tokens` e o teto de iterações, e nenhum deles pode virar silêncio.
 */
export async function runAgent(opts: RunOptions): Promise<AgentResult> {
  const { client, cfg, log } = opts;

  const outcome: AgentOutcome = { escalate: null, stayQuiet: null, toolsUsed: [] };
  const toolContext: ToolContext = { ...opts.toolContext, outcome };
  const messages: Anthropic.Beta.BetaMessageParam[] = [...opts.messages];
  const usage = { input: 0, output: 0, cacheRead: 0 };

  let iterations = 0;
  let reply: string | null = null;

  while (iterations < cfg.AGENT_MAX_ITERATIONS) {
    iterations += 1;

    const response = await client.beta.messages.create({
      model: cfg.CLAUDE_MODEL,
      max_tokens: cfg.CLAUDE_MAX_TOKENS,
      output_config: { effort: cfg.CLAUDE_EFFORT },
      // Fallback do servidor: se o classificador recusar a requisição, a
      // Anthropic reencaminha para outro modelo em vez de devolver nada.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        {
          type: "text",
          text: buildSystemPrompt(),
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOL_DEFINITIONS,
      messages,
    });

    usage.input += response.usage.input_tokens ?? 0;
    usage.output += response.usage.output_tokens ?? 0;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;

    // `stop_details` só vem preenchido em recusa; checar antes de ler content.
    if (response.stop_reason === "refusal") {
      log("modelo recusou a requisição", { categoria: response.stop_details?.category ?? null });
      outcome.escalate ??= {
        motivo: "falha_tecnica",
        resumo: "O modelo recusou processar esta mensagem. Um humano precisa ler a conversa.",
      };
      return { reply: null, outcome, iterations, usage };
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) reply = text;

    if (response.stop_reason === "max_tokens") {
      log("resposta truncada por max_tokens");
      // Uma resposta cortada no meio é pior do que nenhuma: manda para humano.
      outcome.escalate ??= {
        motivo: "falha_tecnica",
        resumo: "A resposta gerada foi truncada. Um humano precisa responder.",
      };
      return { reply: null, outcome, iterations, usage };
    }

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      return { reply, outcome, iterations, usage };
    }

    messages.push({ role: "assistant", content: response.content });

    // Chamadas paralelas são executadas em paralelo e TODOS os resultados
    // voltam na mesma mensagem de usuário — separar em mensagens distintas
    // ensina o modelo a parar de paralelizar.
    const results = await Promise.all(
      toolUses.map(async (block): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        try {
          const content = await executeTool(block.name, block.input, toolContext);
          return { type: "tool_result", tool_use_id: block.id, content };
        } catch (err) {
          const detalhe = err instanceof Error ? err.message : String(err);
          log("ferramenta falhou", { ferramenta: block.name, erro: detalhe });
          return {
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: JSON.stringify({
              erro: "falha_tecnica",
              instrucao:
                "A consulta falhou por um problema técnico. Não tente adivinhar o dado: chame escalar_para_humano com motivo falha_tecnica.",
            }),
          };
        }
      }),
    );

    messages.push({ role: "user", content: results });

    // Depois de decidir escalar ou silenciar, mais uma rodada só serve para o
    // modelo escrever a frase de transição. Duas rodadas extras não.
    if (outcome.stayQuiet) {
      return { reply: null, outcome, iterations, usage };
    }
  }

  log("teto de iterações atingido", { iterations });
  outcome.escalate ??= {
    motivo: "baixa_confianca",
    resumo: "O agente não concluiu o atendimento dentro do limite de consultas. Um humano precisa assumir.",
  };
  return { reply, outcome, iterations, usage };
}
