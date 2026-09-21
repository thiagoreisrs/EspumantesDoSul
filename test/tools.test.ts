import { describe, expect, it, vi } from "vitest";
import { executeTool, isOrderOwnedByContact, type AgentOutcome, type ToolContext } from "../src/agent/tools.js";
import type { ShopifyClient, ShopifyOrder } from "../src/shopify/client.js";

function pedido(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    name: "#1234",
    createdAt: "2026-09-10T12:00:00Z",
    email: "cliente@example.com",
    phone: "+5551999998888",
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    totalPriceSet: { shopMoney: { amount: "289.90", currencyCode: "BRL" } },
    customer: { firstName: "Ana", lastName: "Souza", email: "cliente@example.com", phone: "+5551999998888" },
    shippingAddress: { city: "Porto Alegre", provinceCode: "RS", zip: "90000-000", phone: null },
    lineItems: { nodes: [{ title: "Espumante Brut 750ml", quantity: 2, sku: "ESP-BRUT-750" }] },
    fulfillments: [
      {
        status: "SUCCESS",
        createdAt: "2026-09-12T10:00:00Z",
        estimatedDeliveryAt: null,
        trackingInfo: [{ company: "Correios", number: "AA123456789BR", url: "https://rastreio" }],
      },
    ],
    ...overrides,
  };
}

function contexto(
  orders: ShopifyOrder[],
  contact: ToolContext["contact"],
): { ctx: ToolContext; outcome: AgentOutcome; searchOrders: ReturnType<typeof vi.fn> } {
  const outcome: AgentOutcome = { escalate: null, stayQuiet: null, toolsUsed: [] };
  const searchOrders = vi.fn().mockResolvedValue(orders);
  const ctx: ToolContext = {
    shopify: { searchOrders, searchProducts: vi.fn() } as unknown as ShopifyClient,
    olist: null,
    contact,
    outcome,
  };
  return { ctx, outcome, searchOrders };
}

describe("isOrderOwnedByContact", () => {
  it("aceita quando o telefone do pedido é o do WhatsApp", () => {
    expect(
      isOrderOwnedByContact({
        orderPhones: ["+55 51 99999-8888"],
        orderEmails: ["outro@example.com"],
        contactPhone: "5551999998888",
        contactEmail: null,
      }),
    ).toBe(true);
  });

  it("aceita quando o cliente informa o e-mail da compra", () => {
    expect(
      isOrderOwnedByContact({
        orderPhones: ["+5511000000000"],
        orderEmails: ["cliente@example.com"],
        contactPhone: "5551999998888",
        contactEmail: null,
        providedEmail: "CLIENTE@example.com",
      }),
    ).toBe(true);
  });

  it("recusa quando nada bate", () => {
    expect(
      isOrderOwnedByContact({
        orderPhones: ["+5511000000000"],
        orderEmails: ["outro@example.com"],
        contactPhone: "5551999998888",
        contactEmail: "eu@example.com",
      }),
    ).toBe(false);
  });
});

describe("buscar_pedido", () => {
  it("devolve os dados quando o telefone confere", async () => {
    const { ctx } = contexto([pedido()], { phone: "+55 51 99999-8888", email: null, name: "Ana" });
    const raw = await executeTool("buscar_pedido", { numero_pedido: "#1234" }, ctx);
    const out = JSON.parse(raw);

    expect(out.autorizado).toBe(true);
    expect(out.pedidos[0].numero).toBe("#1234");
    expect(out.pedidos[0].pagamento).toBe("pago");
    expect(out.pedidos[0].envio).toBe("enviado");
    expect(out.pedidos[0].rastreios[0].codigo).toBe("AA123456789BR");
  });

  it("não vaza dados de pedido de outra pessoa", async () => {
    const { ctx } = contexto([pedido()], { phone: "+5511911112222", email: null, name: "Fulano" });
    const out = JSON.parse(await executeTool("buscar_pedido", { numero_pedido: "1234" }, ctx));

    expect(out.autorizado).toBe(false);
    expect(out.motivo).toBe("titularidade_nao_confirmada");
    expect(JSON.stringify(out)).not.toContain("Ana");
    expect(JSON.stringify(out)).not.toContain("289.90");
  });

  it("normaliza o número do pedido antes de consultar o Shopify", async () => {
    const { ctx, searchOrders } = contexto([], { phone: "+5551999998888", email: null });
    await executeTool("buscar_pedido", { numero_pedido: "pedido #1234" }, ctx);
    expect(searchOrders).toHaveBeenCalledWith("name:#1234");
  });

  it("pede identificação quando não há nenhum dado", async () => {
    const { ctx } = contexto([], { phone: null, email: null });
    const out = JSON.parse(await executeTool("buscar_pedido", {}, ctx));
    expect(out.encontrado).toBe(false);
    expect(out.motivo).toBe("sem_identificador");
  });
});

describe("escalar_para_humano / nao_responder", () => {
  it("registra o escalonamento no resultado da execução", async () => {
    const { ctx, outcome } = contexto([], { phone: null, email: null });
    await executeTool("escalar_para_humano", { motivo: "reclamacao", resumo: "Cliente irritado." }, ctx);
    expect(outcome.escalate).toEqual({ motivo: "reclamacao", resumo: "Cliente irritado." });
  });

  it("registra a decisão de silêncio", async () => {
    const { ctx, outcome } = contexto([], { phone: null, email: null });
    await executeTool("nao_responder", { motivo: "spam" }, ctx);
    expect(outcome.stayQuiet).toEqual({ motivo: "spam" });
  });
});
