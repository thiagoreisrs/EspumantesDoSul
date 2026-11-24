import { describe, expect, it } from "vitest";
import {
  classificarEstilos,
  combinaComEstilo,
  filtrarPorFaixa,
  levantarFacetas,
  montarFaixa,
  variantePreferida,
} from "../src/agent/recomendacao.js";
import type { ShopifyProduct } from "../src/shopify/client.js";

function produto(
  nome: string,
  variantes: Array<{ nome?: string; preco: number; disponivel?: boolean }>,
  extra: Partial<ShopifyProduct> = {},
): ShopifyProduct {
  const precos = variantes.map((v) => v.preco);
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
    priceRangeV2: { minVariantPrice: { amount: String(Math.min(...precos)), currencyCode: "BRL" } },
    variants: {
      nodes: variantes.map((v, i) => ({
        title: v.nome ?? `Variante ${i + 1}`,
        sku: `SKU-${i}`,
        price: String(v.preco),
        availableForSale: v.disponivel ?? true,
        inventoryQuantity: 5,
      })),
    },
    ...extra,
  };
}

describe("montarFaixa", () => {
  it("abre 30% abaixo e 10% acima de um valor aproximado", () => {
    // "quero algo de uns R$150"
    expect(montarFaixa({ precoAlvo: 150 })).toEqual({ piso: 105, teto: 165, alvo: 150 });
  });

  it("nunca ultrapassa um teto declarado", () => {
    // "até R$150" é limite de bolso, não desejo.
    const faixa = montarFaixa({ precoMax: 150 })!;
    expect(faixa.teto).toBe(150);
    expect(faixa.piso).toBe(105);
  });

  it("usa min e max quando os dois vêm", () => {
    expect(montarFaixa({ precoMin: 80, precoMax: 120 })).toEqual({ piso: 80, teto: 120, alvo: 100 });
  });

  it("deixa o teto aberto quando só há piso", () => {
    const faixa = montarFaixa({ precoMin: 200 })!;
    expect(faixa.piso).toBe(200);
    expect(faixa.teto).toBe(Number.POSITIVE_INFINITY);
  });

  it("devolve null sem nenhum critério, e ignora valores inválidos", () => {
    expect(montarFaixa({})).toBeNull();
    expect(montarFaixa({ precoAlvo: 0 })).toBeNull();
    expect(montarFaixa({ precoAlvo: Number.NaN })).toBeNull();
    expect(montarFaixa({ precoAlvo: -50 })).toBeNull();
  });
});

describe("variantePreferida", () => {
  it("julga pela variante, não pelo menor preço do produto", () => {
    // Garrafa a R$30 e caixa de seis a R$170: numa conversa sobre R$150
    // quem atende é a caixa, e o produto não pode ser descartado por causa
    // do preço da unidade.
    const p = produto("Espumante X", [
      { nome: "Garrafa", preco: 30 },
      { nome: "Caixa com 6", preco: 170 },
    ]);
    const faixa = montarFaixa({ precoAlvo: 160 })!;
    expect(variantePreferida(p, faixa)).toMatchObject({ nome: "Caixa com 6", preco: 170 });
  });

  it("ignora variante indisponível", () => {
    const p = produto("Espumante Y", [
      { nome: "Garrafa", preco: 150, disponivel: false },
      { nome: "Caixa", preco: 900 },
    ]);
    expect(variantePreferida(p, montarFaixa({ precoAlvo: 150 }))).toBeNull();
  });

  it("devolve null quando nenhuma variante cabe na faixa", () => {
    const p = produto("Espumante Z", [{ preco: 30 }]);
    expect(variantePreferida(p, montarFaixa({ precoAlvo: 150 }))).toBeNull();
  });
});

describe("filtrarPorFaixa", () => {
  const catalogo = [
    produto("Barato 30", [{ preco: 30 }]),
    produto("Barato 60", [{ preco: 60 }]),
    produto("Justo 120", [{ preco: 120 }]),
    produto("Justo 150", [{ preco: 150 }]),
    produto("Justo 160", [{ preco: 160 }]),
    produto("Caro 400", [{ preco: 400 }]),
  ];

  it("não oferece nada muito abaixo do que o cliente pediu", () => {
    // Regressão do caso real: cliente pediu R$150 e recebeu opções de R$30.
    const { dentro } = filtrarPorFaixa(catalogo, montarFaixa({ precoAlvo: 150 }));
    const nomes = dentro.map((d) => d.produto.title);
    expect(nomes).not.toContain("Barato 30");
    expect(nomes).not.toContain("Barato 60");
    expect(dentro.every((d) => d.variante.preco >= 105)).toBe(true);
  });

  it("inclui um pouco acima do pedido, mas não o destoante", () => {
    const { dentro } = filtrarPorFaixa(catalogo, montarFaixa({ precoAlvo: 150 }));
    const nomes = dentro.map((d) => d.produto.title);
    expect(nomes).toContain("Justo 160");
    expect(nomes).not.toContain("Caro 400");
  });

  it("ordena pela proximidade do que o cliente pediu", () => {
    const { dentro } = filtrarPorFaixa(catalogo, montarFaixa({ precoAlvo: 150 }));
    expect(dentro.map((d) => d.produto.title)).toEqual(["Justo 150", "Justo 160", "Justo 120"]);
  });

  it("conta os descartados e guarda a melhor opção abaixo do piso", () => {
    const { descartadosPorPreco, maisProximoAbaixo } = filtrarPorFaixa(catalogo, montarFaixa({ precoAlvo: 150 }));
    expect(descartadosPorPreco).toBe(3); // 30, 60 e 400
    expect(maisProximoAbaixo?.produto.title).toBe("Barato 60");
  });

  it("respeita teto rígido sem arredondar para cima", () => {
    const { dentro } = filtrarPorFaixa(catalogo, montarFaixa({ precoMax: 150 }));
    expect(dentro.every((d) => d.variante.preco <= 150)).toBe(true);
    expect(dentro.map((d) => d.produto.title)).not.toContain("Justo 160");
  });

  it("sem faixa, devolve o catálogo ativo sem filtrar preço", () => {
    const { dentro, descartadosPorPreco } = filtrarPorFaixa(catalogo, null, 10);
    expect(dentro).toHaveLength(6);
    expect(descartadosPorPreco).toBe(0);
  });

  it("descarta produto fora do ar", () => {
    const rascunho = produto("Rascunho", [{ preco: 150 }], { status: "DRAFT" });
    const { dentro } = filtrarPorFaixa([...catalogo, rascunho], montarFaixa({ precoAlvo: 150 }));
    expect(dentro.map((d) => d.produto.title)).not.toContain("Rascunho");
  });

  it("respeita o limite de opções", () => {
    const { dentro } = filtrarPorFaixa(catalogo, montarFaixa({ precoAlvo: 150 }), 2);
    expect(dentro).toHaveLength(2);
  });
});

describe("levantarFacetas", () => {
  it("resume o que existe para o agente perguntar com conhecimento", () => {
    const facetas = levantarFacetas([
      produto("A", [{ preco: 45 }], { vendor: "Casa Valduga", productType: "Moscatel" }),
      produto("B", [{ preco: 220 }], { vendor: "Aurora", productType: "Brut" }),
      produto("C", [{ preco: 90 }], { vendor: "Aurora", productType: "Brut" }),
    ]);
    expect(facetas.vinicolas).toEqual(["Aurora", "Casa Valduga"]);
    expect(facetas.tipos).toEqual(["Brut", "Moscatel"]);
    expect(facetas.precoMin).toBe(45);
    expect(facetas.precoMax).toBe(220);
  });

  it("ignora indisponível e fora do ar no cálculo da faixa", () => {
    const facetas = levantarFacetas([
      produto("A", [{ preco: 45, disponivel: false }, { preco: 100 }]),
      produto("B", [{ preco: 900 }], { status: "DRAFT" }),
    ]);
    expect(facetas.precoMin).toBe(100);
    expect(facetas.precoMax).toBe(100);
  });
});

// ------------------------------------------------------------- estilos --

/** Produto real da loja: o campo "Tipo" do Shopify vem vazio. */
const DALLA_COSTA_MOSCATEL = produto("Dalla Costa Espumante Moscatel", [{ preco: 89 }], {
  vendor: "Dalla Costa",
  productType: null,
  tags: ["Vinho Espumante", "Moscato", "Moscatel", "Dalla Costa", "Branco", "750ml"],
});

describe("classificarEstilos", () => {
  it("classifica mesmo com o campo Tipo do Shopify vazio", () => {
    // Regressão: a loja não preenche productType. Se dependêssemos dele, o
    // agente não teria nenhum tipo para oferecer ao perguntar.
    expect(DALLA_COSTA_MOSCATEL.productType).toBeNull();
    expect(classificarEstilos(DALLA_COSTA_MOSCATEL)).toContain("Moscatel");
  });

  it("lê o estilo do nome do produto quando não há tag", () => {
    const p = produto("Aurora Espumante Brut", [{ preco: 70 }], { productType: null, tags: [] });
    expect(classificarEstilos(p)).toContain("Brut");
  });

  it("não duplica Brut quando o rótulo é Extra Brut ou Nature", () => {
    const extra = produto("Casa Valduga Extra Brut", [{ preco: 120 }], { productType: null, tags: [] });
    expect(classificarEstilos(extra)).toContain("Extra Brut");
    expect(classificarEstilos(extra)).not.toContain("Brut");

    const nature = produto("Espumante Brut Nature", [{ preco: 140 }], { productType: null, tags: [] });
    expect(classificarEstilos(nature)).toContain("Nature");
    expect(classificarEstilos(nature)).not.toContain("Brut");
  });

  it("entende moscatéis acentuado e plural", () => {
    const p = produto("Espumante", [{ preco: 60 }], { productType: null, tags: ["Espumantes Moscatéis"] });
    expect(classificarEstilos(p)).toContain("Moscatel");
  });
});

describe("combinaComEstilo", () => {
  const brut = produto("Aurora Brut", [{ preco: 90 }], { productType: null, tags: ["Brut"] });
  const demiSec = produto("Garibaldi Demi-Sec", [{ preco: 70 }], { productType: null, tags: ["Demi-Sec"] });

  it("traduz 'seco' do cliente para a família Brut", () => {
    // Nenhum rótulo seco diz "seco"; só o demi-sec se identifica. Sem esta
    // tradução, a resposta mais provável do cliente devolveria zero produto.
    expect(combinaComEstilo(brut, "seco")).toBe(true);
    expect(combinaComEstilo(DALLA_COSTA_MOSCATEL, "seco")).toBe(false);
  });

  it("nunca entrega um demi-sec a quem pediu seco", () => {
    // "seco" é substring de "meio seco": sem tratamento, casaria com o oposto.
    expect(combinaComEstilo(demiSec, "seco")).toBe(false);
  });

  it("traduz 'doce' para moscatel e demi-sec", () => {
    expect(combinaComEstilo(DALLA_COSTA_MOSCATEL, "doce")).toBe(true);
    expect(combinaComEstilo(demiSec, "adocicado")).toBe(true);
    expect(combinaComEstilo(brut, "doce")).toBe(false);
  });

  it("aceita o nome técnico do estilo", () => {
    expect(combinaComEstilo(DALLA_COSTA_MOSCATEL, "Moscatel")).toBe(true);
    expect(combinaComEstilo(DALLA_COSTA_MOSCATEL, "moscato")).toBe(true);
    expect(combinaComEstilo(brut, "Brut")).toBe(true);
  });

  it("cai no título e nas tags para palavra fora do vocabulário", () => {
    expect(combinaComEstilo(DALLA_COSTA_MOSCATEL, "750ml")).toBe(true);
    expect(combinaComEstilo(brut, "750ml")).toBe(false);
  });

  it("sem estilo pedido, não filtra nada", () => {
    expect(combinaComEstilo(brut, "")).toBe(true);
  });
});

describe("levantarFacetas com catálogo real", () => {
  it("tira os tipos das tags, já que o campo Tipo vem vazio", () => {
    const facetas = levantarFacetas([
      DALLA_COSTA_MOSCATEL,
      produto("Aurora Brut", [{ preco: 70 }], { vendor: "Aurora", productType: null, tags: ["Brut"] }),
    ]);
    expect(facetas.tipos).toEqual(["Branco", "Brut", "Moscatel"]);
    expect(facetas.vinicolas).toEqual(["Aurora", "Dalla Costa"]);
  });
});

// -------------------------------------------------- seco: tag e sinônimo --

/** Vinho fino real da loja: a secura está na tag, não no título. */
const GUATAMBU_TINTO = produto("Guatambu Épico IX", [{ preco: 189 }], {
  vendor: "Guatambu",
  productType: null,
  tags: ["Vinho Fino", "Tinto", "Seco"],
});

describe("Seco como estilo próprio", () => {
  it("lê a tag Seco dos vinhos finos, mesmo sem nada no título", () => {
    const estilos = classificarEstilos(GUATAMBU_TINTO);
    expect(estilos).toContain("Seco");
    expect(estilos).toContain("Tinto");
  });

  it("não marca um demi-sec como seco", () => {
    // "meio seco" contém "seco"; sem tratamento, o oposto casaria.
    const meioSeco = produto("Espumante Meio Seco", [{ preco: 60 }], { productType: null, tags: ["Meio Seco"] });
    const estilos = classificarEstilos(meioSeco);
    expect(estilos).toContain("Demi-Sec");
    expect(estilos).not.toContain("Seco");
  });

  it("'seco' do cliente alcança tanto o vinho fino quanto o espumante brut", () => {
    // A loja marca a mesma ideia de dois jeitos: tag "Seco" nos vinhos finos,
    // Brut/Nature nos espumantes. A pergunta do agente é uma só.
    const brut = produto("Aurora Brut", [{ preco: 90 }], { productType: null, tags: ["Brut"] });
    expect(combinaComEstilo(GUATAMBU_TINTO, "seco")).toBe(true);
    expect(combinaComEstilo(brut, "seco")).toBe(true);
    expect(combinaComEstilo(DALLA_COSTA_MOSCATEL, "seco")).toBe(false);
  });

  it("quem pede doce não recebe o tinto seco", () => {
    expect(combinaComEstilo(GUATAMBU_TINTO, "doce")).toBe(false);
  });

  it("aceita 'tinto' e 'Seco' como termo direto", () => {
    expect(combinaComEstilo(GUATAMBU_TINTO, "tinto")).toBe(true);
    expect(combinaComEstilo(GUATAMBU_TINTO, "Seco")).toBe(true);
  });
});
