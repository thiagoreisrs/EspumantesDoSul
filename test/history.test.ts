import { describe, expect, it } from "vitest";
import { buildHistory } from "../src/conversation/history.js";
import type { ChatwootMessage } from "../src/chatwoot/types.js";

const msg = (id: number, type: ChatwootMessage["message_type"], content: string, priv = false): ChatwootMessage => ({
  id,
  message_type: type,
  content,
  private: priv,
});

describe("buildHistory", () => {
  it("mapeia incoming para user e outgoing para assistant", () => {
    const history = buildHistory([msg(1, "incoming", "oi"), msg(2, "outgoing", "olá!")], 20);
    expect(history).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: "olá!" },
    ]);
  });

  it("funde mensagens consecutivas do mesmo papel", () => {
    const history = buildHistory(
      [msg(1, "incoming", "oi"), msg(2, "incoming", "queria saber do pedido"), msg(3, "incoming", "é o 1234")],
      20,
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ role: "user", content: "oi\nqueria saber do pedido\né o 1234" });
  });

  it("descarta nota privada, evento de sistema e conteúdo vazio", () => {
    const history = buildHistory(
      [
        msg(1, "incoming", "oi"),
        msg(2, "outgoing", "nota interna", true),
        msg(3, "activity", "conversa resolvida"),
        msg(4, "outgoing", "   "),
      ],
      20,
    );
    expect(history).toEqual([{ role: "user", content: "oi" }]);
  });

  it("sempre começa com o cliente", () => {
    const history = buildHistory([msg(1, "outgoing", "campanha"), msg(2, "incoming", "oi")], 20);
    expect(history[0]!.role).toBe("user");
  });

  it("respeita o limite de histórico", () => {
    const muitas = Array.from({ length: 50 }, (_, i) =>
      msg(i, i % 2 === 0 ? "incoming" : "outgoing", `m${i}`),
    );
    const history = buildHistory(muitas, 10);
    expect(history.length).toBeLessThanOrEqual(10);
  });
});
