import { describe, expect, it } from "vitest";
import { lerMetacampos, valoresDe } from "../src/shopify/metacampos.js";
import { classificarEstilos, combinaComEstilo, combinaComTexto } from "../src/agent/recomendacao.js";
import type { ShopifyMetafield, ShopifyProduct } from "../src/shopify/client.js";

const lista = (key: string, valores: string[]): ShopifyMetafield => ({
  namespace: "custom",
  key,
  type: "list.single_line_text_field",
  value: JSON.stringify(valores),
});

const texto = (key: string, valor: string): ShopifyMetafield => ({
  namespace: "custom",
  key,
  type: "single_line_text_field",
  value: valor,
});

const numero = (key: string, valor: number): ShopifyMetafield => ({
  namespace: "custom",
  key,
  type: "number_integer",
  value: String(valor),
});

/** Ficha real do Guatambu Épico IX, como aparece nos metacampos da loja. */
const METACAMPOS_GUATAMBU: ShopifyMetafield[] = [
  texto("tipo", "Vinho Fino Tinto Seco"),
  texto("docura_texto", "Brut"),
  numero("docura_nivel", 5),
  lista("ocasiao", ["Jantar Especial", "Celebração", "Inverno"]),
  lista("harmonizacao", ["Costela de fogo de chão", "Queijos curados"]),
  lista("uvas", ["Tannat", "Cabernet Sauvignon", "Tempranillo", "Merlot"]),
  texto("regiao", "Campanha Gaúcha – Dom Pedrito, RS"),
  texto("temperatura", "18 °C a 20 °C"),
  texto("corpo_texto", "Encorpado"),
  numero("corpo_nivel", 85),
  texto("volume", "750ml"),
  texto("descricao_editorial", "Um texto longo demais para a resposta do WhatsApp."),
];

function comFicha(nome: string, metafields: ShopifyMetafield[], extra: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    title: nome,
    handle: "p",
    status: "ACTIVE",
    vendor: "Guatambu",
    productType: null,
    tags: [],
    onlineStoreUrl: null,
    totalInventory: 5,
    description: null,
    priceRangeV2: { minVariantPrice: { amount: "189", currencyCode: "BRL" } },
    variants: {
      nodes: [{ title: "Garrafa", sku: "G1", price: "189", availableForSale: true, inventoryQuantity: 3 }],
    },
    metafields: { nodes: metafields },
    ...extra,
  };
}

const GUATAMBU = comFicha("Guatambu Épico IX", METACAMPOS_GUATAMBU);

describe("valoresDe", () => {
  it("abre lista em JSON e mantém texto simples", () => {
    expect(valoresDe(lista("ocasiao", ["Celebração", "Inverno"]))).toEqual(["Celebração", "Inverno"]);
    expect(valoresDe(texto("regiao", "Campanha Gaúcha"))).toEqual(["Campanha Gaúcha"]);
    expect(valoresDe(texto("vazio", "   "))).toEqual([]);
  });

  it("não quebra com JSON malformado", () => {
    expect(valoresDe({ namespace: "c", key: "k", type: "list.single_line_text_field", value: "[não é json" }))
      .toEqual(["[não é json"]);
  });
});

describe("lerMetacampos", () => {
  it("lê a ficha do produto real", () => {
    const m = lerMetacampos(GUATAMBU);
    expect(m.tipo).toBe("Vinho Fino Tinto Seco");
    expect(m.docuraTexto).toBe("Brut");
    expect(m.docuraNivel).toBe(5);
    expect(m.ocasioes).toEqual(["Jantar Especial", "Celebração", "Inverno"]);
    expect(m.uvas).toContain("Tannat");
    expect(m.regiao).toContain("Campanha Gaúcha");
    expect(m.temperatura).toBe("18 °C a 20 °C");
    expect(m.corpo).toBe("Encorpado");
  });

  it("não confunde 'docura_nivel' com 'docura_texto'", () => {
    const m = lerMetacampos(GUATAMBU);
    expect(m.docuraNivel).toBe(5);
    expect(m.docuraTexto).toBe("Brut");
  });

  it("guarda o que não reconhece, em vez de descartar", () => {
    // A loja pode criar metacampo novo sem ninguém mexer no código; o agente
    // ainda consegue usar para responder, mesmo sem servir de filtro.
    expect(lerMetacampos(GUATAMBU).ficha).toHaveProperty("volume", "750ml");
  });

  it("deixa de fora texto longo e número solto", () => {
    const ficha = lerMetacampos(GUATAMBU).ficha;
    expect(ficha).not.toHaveProperty("descricao_editorial");
    expect(ficha).not.toHaveProperty("corpo_nivel");
  });

  it("devolve vazio para produto sem metacampo", () => {
    const m = lerMetacampos(comFicha("Sem ficha", []));
    expect(m.tipo).toBeNull();
    expect(m.ocasioes).toEqual([]);
    expect(m.ficha).toEqual({});
  });
});

describe("metacampos na classificação", () => {
  it("usa o metacampo Tipo, mesmo sem tag e sem nada no título", () => {
    expect(GUATAMBU.tags).toEqual([]);
    const estilos = classificarEstilos(GUATAMBU);
    expect(estilos).toContain("Seco");
    expect(estilos).toContain("Tinto");
  });

  it("não transforma a doçura 'Brut' de um tinto em estilo Brut", () => {
    // A loja usa "Brut" como nível de doçura, inclusive em tinto. Quem pede
    // "um brut" no WhatsApp quer espumante, não um Tannat encorpado.
    expect(classificarEstilos(GUATAMBU)).not.toContain("Brut");
    expect(combinaComEstilo(GUATAMBU, "Brut")).toBe(false);
  });

  it("responde 'seco' pelo metacampo de doçura", () => {
    expect(combinaComEstilo(GUATAMBU, "seco")).toBe(true);
    expect(combinaComEstilo(GUATAMBU, "doce")).toBe(false);
  });

  it("o metacampo vence a tag quando os dois existem", () => {
    // Tag diz Moscatel, ficha diz Brut: a ficha é a fonte boa.
    const conflito = comFicha("Conflito", [texto("docura_texto", "Brut")], { tags: ["Moscatel"] });
    expect(combinaComEstilo(conflito, "seco")).toBe(true);
    expect(combinaComEstilo(conflito, "doce")).toBe(false);
  });

  it("cai no nível numérico quando não há texto de doçura", () => {
    const seco = comFicha("Seco", [numero("docura_nivel", 5)]);
    const doce = comFicha("Doce", [numero("docura_nivel", 80)]);
    expect(combinaComEstilo(seco, "seco")).toBe(true);
    expect(combinaComEstilo(doce, "doce")).toBe(true);
    expect(combinaComEstilo(doce, "seco")).toBe(false);
  });

  it("sem ficha nenhuma, ainda decide pela tag", () => {
    const porTag = comFicha("Por tag", [], { tags: ["Moscatel"] });
    expect(combinaComEstilo(porTag, "doce")).toBe(true);
  });
});

describe("combinaComTexto", () => {
  it("casa ocasião, prato e uva", () => {
    expect(combinaComTexto(GUATAMBU, "ocasioes", "celebração")).toBe(true);
    expect(combinaComTexto(GUATAMBU, "harmonizacoes", "costela")).toBe(true);
    expect(combinaComTexto(GUATAMBU, "uvas", "tannat")).toBe(true);
  });

  it("ignora acento e diferença de caixa", () => {
    expect(combinaComTexto(GUATAMBU, "ocasioes", "CELEBRACAO")).toBe(true);
  });

  it("recusa o que não está na ficha", () => {
    expect(combinaComTexto(GUATAMBU, "harmonizacoes", "sobremesa")).toBe(false);
    expect(combinaComTexto(GUATAMBU, "uvas", "chardonnay")).toBe(false);
  });

  it("produto sem o metacampo não entra no filtro", () => {
    expect(combinaComTexto(comFicha("Sem ficha", []), "ocasioes", "celebração")).toBe(false);
  });
});
