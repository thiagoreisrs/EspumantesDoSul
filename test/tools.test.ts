import { describe, expect, it, vi } from "vitest";
import { executeTool, isOrderOwnedByContact, type AgentOutcome, type ToolContext } from "../src/agent/tools.js";
import type { ShopifyClient, ShopifyOrder, ShopifyProduct } from "../src/shopify/client.js";

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

// --------------------------------------------------------- buscar_produto --

function produtoShopify(
  nome: string,
  preco: number,
  extra: Partial<ShopifyProduct> = {},
): ShopifyProduct {
  return {
    title: nome,
    handle: nome.toLowerCase().replace(/\s+/g, "-"),
    status: "ACTIVE",
    vendor: "Vinícola Teste",
    productType: "Brut",
    tags: [],
    onlineStoreUrl: `https://loja/${nome}`,
    totalInventory: 10,
    description: null,
    priceRangeV2: { minVariantPrice: { amount: String(preco), currencyCode: "BRL" } },
    variants: {
      nodes: [
        { title: "Garrafa", sku: `SKU-${nome}`, price: String(preco), availableForSale: true, inventoryQuantity: 5 },
      ],
    },
    ...extra,
  };
}

function contextoProduto(produtos: ShopifyProduct[]) {
  const outcome: AgentOutcome = { escalate: null, stayQuiet: null, toolsUsed: [] };
  const searchProducts = vi.fn().mockResolvedValue(produtos);
  const ctx: ToolContext = {
    shopify: { searchOrders: vi.fn(), searchProducts } as unknown as ShopifyClient,
    olist: null,
    contact: { phone: "+5551999998888", email: null },
    outcome,
  };
  return { ctx, searchProducts };
}

const CATALOGO_LARGO = [
  produtoShopify("Barato 30", 30),
  produtoShopify("Barato 55", 55),
  produtoShopify("Medio 120", 120),
  produtoShopify("Justo 150", 150),
  produtoShopify("Justo 160", 160),
  produtoShopify("Caro 400", 400),
  produtoShopify("Caro 600", 600),
];

describe("buscar_produto", () => {
  it("pede para qualificar em vez de listar quando o cliente não deu critério", async () => {
    const { ctx } = contextoProduto(CATALOGO_LARGO);
    const out = JSON.parse(await executeTool("buscar_produto", { termo: "espumante" }, ctx));

    expect(out.precisa_qualificar).toBe(true);
    expect(out.produtos).toBeUndefined();
    expect(out.instrucao).toMatch(/NÃO liste produtos ainda/);
    // Precisa devolver o que existe, senão o agente pergunta no escuro.
    expect(out.tipos_disponiveis).toContain("Brut");
    expect(out.faixa_de_preco_no_catalogo).toEqual({ min: 30, max: 600 });
  });

  it("lista direto quando o cliente já foi específico, sem interrogar", async () => {
    const { ctx } = contextoProduto([produtoShopify("Chandon Brut", 120)]);
    const out = JSON.parse(await executeTool("buscar_produto", { termo: "Chandon Brut" }, ctx));

    expect(out.precisa_qualificar).toBeUndefined();
    expect(out.encontrado).toBe(true);
    expect(out.produtos[0].nome).toBe("Chandon Brut");
  });

  it("não devolve opções muito abaixo da faixa pedida", async () => {
    // O caso real: cliente pediu R$150 e recebeu sugestões de R$30.
    const { ctx } = contextoProduto(CATALOGO_LARGO);
    const out = JSON.parse(await executeTool("buscar_produto", { termo: "espumante", preco_alvo: 150 }, ctx));

    const nomes = out.produtos.map((p: { nome: string }) => p.nome);
    expect(nomes).not.toContain("Barato 30");
    expect(nomes).not.toContain("Barato 55");
    expect(nomes[0]).toBe("Justo 150");
    expect(out.produtos.every((p: { preco: number }) => p.preco >= 105 && p.preco <= 165)).toBe(true);
    expect(out.descartados_por_preco).toBe(4);
  });

  it("respeita teto declarado sem oferecer acima", async () => {
    const { ctx } = contextoProduto(CATALOGO_LARGO);
    const out = JSON.parse(await executeTool("buscar_produto", { termo: "espumante", preco_max: 150 }, ctx));
    expect(out.produtos.every((p: { preco: number }) => p.preco <= 150)).toBe(true);
  });

  it("admite que não tem nada na faixa em vez de empurrar o barato", async () => {
    const { ctx } = contextoProduto([produtoShopify("Barato 30", 30), produtoShopify("Barato 40", 40)]);
    const out = JSON.parse(await executeTool("buscar_produto", { termo: "espumante", preco_alvo: 300 }, ctx));

    expect(out.encontrado).toBe(false);
    expect(out.motivo).toBe("nada_na_faixa");
    expect(out.opcao_mais_proxima.nome).toBe("Barato 40");
    expect(out.instrucao).toMatch(/NÃO empurre/);
  });

  it("manda o tipo como busca livre, não como product_type", async () => {
    // A loja não preenche o campo Tipo do Shopify: filtrar por product_type
    // devolveria zero resultado sempre. O estilo vive no título e nas tags,
    // que a busca livre alcança.
    const alvo = produtoShopify("Aurora Moscatel", 90, {
      vendor: "Aurora",
      productType: null,
      tags: ["Moscatel"],
    });
    const { ctx, searchProducts } = contextoProduto([alvo]);
    const out = JSON.parse(
      await executeTool(
        "buscar_produto",
        { termo: "espumante", vinicola: "Aurora", tipo: "Moscatel", preco_alvo: 90 },
        ctx,
      ),
    );
    expect(searchProducts).toHaveBeenCalledWith('espumante Moscatel vendor:"Aurora"', 25);
    expect(out.produtos[0].nome).toBe("Aurora Moscatel");
  });

  it("descarta o vizinho que a busca livre trouxe e não é do tipo pedido", async () => {
    const moscatel = produtoShopify("Dalla Costa Moscatel", 90, { productType: null, tags: ["Moscatel"] });
    const brut = produtoShopify("Dalla Costa Brut", 95, { productType: null, tags: ["Brut"] });
    const { ctx } = contextoProduto([moscatel, brut]);

    const out = JSON.parse(
      await executeTool("buscar_produto", { termo: "espumante", tipo: "doce", preco_alvo: 90 }, ctx),
    );
    const nomes = out.produtos.map((p: { nome: string }) => p.nome);
    expect(nomes).toContain("Dalla Costa Moscatel");
    expect(nomes).not.toContain("Dalla Costa Brut");
  });

  it("neutraliza aspas para não quebrar a sintaxe da busca", async () => {
    const { ctx, searchProducts } = contextoProduto([]);
    await executeTool("buscar_produto", { termo: 'esp"umante', vinicola: 'Au"rora' }, ctx);
    const consulta = searchProducts.mock.calls[0]![0] as string;
    expect(consulta).not.toMatch(/[a-z]"[a-z]/);
  });
});

describe("buscar_produto com metacampos", () => {
  const comMeta = (nome: string, preco: number, metafields: ShopifyProduct["metafields"]) =>
    produtoShopify(nome, preco, { productType: null, tags: [], metafields });

  const guatambu = comMeta("Guatambu Épico IX", 189, {
    nodes: [
      { namespace: "custom", key: "tipo", type: "single_line_text_field", value: "Vinho Fino Tinto Seco" },
      { namespace: "custom", key: "docura_texto", type: "single_line_text_field", value: "Brut" },
      {
        namespace: "custom",
        key: "harmonizacao",
        type: "list.single_line_text_field",
        value: JSON.stringify(["Costela de fogo de chão"]),
      },
      {
        namespace: "custom",
        key: "ocasiao",
        type: "list.single_line_text_field",
        value: JSON.stringify(["Jantar Especial", "Celebração"]),
      },
      { namespace: "custom", key: "uvas", type: "list.single_line_text_field", value: JSON.stringify(["Tannat"]) },
      { namespace: "custom", key: "regiao", type: "single_line_text_field", value: "Campanha Gaúcha" },
      { namespace: "custom", key: "temperatura", type: "single_line_text_field", value: "18 °C a 20 °C" },
    ],
  });

  const moscatel = comMeta("Dalla Costa Moscatel", 170, {
    nodes: [
      { namespace: "custom", key: "docura_texto", type: "single_line_text_field", value: "Moscatel" },
      {
        namespace: "custom",
        key: "harmonizacao",
        type: "list.single_line_text_field",
        value: JSON.stringify(["Sobremesas", "Torta de frutas"]),
      },
    ],
  });

  it("filtra pelo prato que o cliente citou", async () => {
    const { ctx } = contextoProduto([guatambu, moscatel]);
    const out = JSON.parse(
      await executeTool("buscar_produto", { termo: "vinho", harmonizacao: "costela", preco_alvo: 180 }, ctx),
    );
    const nomes = out.produtos.map((p: { nome: string }) => p.nome);
    expect(nomes).toEqual(["Guatambu Épico IX"]);
  });

  it("filtra por ocasião", async () => {
    const { ctx } = contextoProduto([guatambu, moscatel]);
    const out = JSON.parse(
      await executeTool("buscar_produto", { termo: "vinho", ocasiao: "Celebração", preco_alvo: 180 }, ctx),
    );
    expect(out.produtos.map((p: { nome: string }) => p.nome)).toEqual(["Guatambu Épico IX"]);
  });

  it("entrega a ficha técnica junto, para a indicação ter argumento", async () => {
    const { ctx } = contextoProduto([guatambu]);
    const out = JSON.parse(await executeTool("buscar_produto", { termo: "vinho", preco_alvo: 180 }, ctx));
    const p = out.produtos[0];
    expect(p.tipo).toBe("Vinho Fino Tinto Seco");
    expect(p.regiao).toBe("Campanha Gaúcha");
    expect(p.temperatura).toBe("18 °C a 20 °C");
    expect(p.uvas).toEqual(["Tannat"]);
    expect(p.harmoniza_com).toContain("Costela de fogo de chão");
  });

  it("'seco' do cliente usa a ficha e não entrega o moscatel", async () => {
    const { ctx } = contextoProduto([guatambu, moscatel]);
    const out = JSON.parse(
      await executeTool("buscar_produto", { termo: "vinho", tipo: "seco", preco_alvo: 180 }, ctx),
    );
    expect(out.produtos.map((p: { nome: string }) => p.nome)).toEqual(["Guatambu Épico IX"]);
  });

  it("oferece as ocasiões reais ao pedir qualificação", async () => {
    const catalogo = [...CATALOGO_LARGO.slice(0, 6), guatambu];
    const { ctx } = contextoProduto(catalogo);
    const out = JSON.parse(await executeTool("buscar_produto", { termo: "vinho" }, ctx));
    expect(out.precisa_qualificar).toBe(true);
    expect(out.ocasioes_disponiveis).toContain("Jantar Especial");
  });
});
