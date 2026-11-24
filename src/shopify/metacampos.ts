import type { ShopifyMetafield, ShopifyProduct } from "./client.js";

/**
 * Leitura dos metacampos do produto.
 *
 * A loja mantém a ficha real do vinho aqui — doçura, tipo, ocasião,
 * harmonização, uvas, região —, e não nos campos nativos do Shopify, que vêm
 * vazios. Esta é a fonte boa; tag e título são a rede de segurança.
 *
 * Não assumimos os nomes técnicos das definições: buscamos todos os metacampos
 * do produto e casamos pela chave normalizada. O que não reconhecemos não é
 * descartado — vai para `ficha`, onde o agente ainda pode usar para responder,
 * mesmo sem servir de filtro.
 */

export interface Metacampos {
  tipo: string | null;
  docuraTexto: string | null;
  /** Escala da loja, onde o menor é o mais seco. */
  docuraNivel: number | null;
  ocasioes: string[];
  harmonizacoes: string[];
  uvas: string[];
  regiao: string | null;
  temperatura: string | null;
  corpo: string | null;
  acidez: string | null;
  complexidade: string | null;
  /** Metacampos de texto que não reconhecemos, por rótulo legível. */
  ficha: Record<string, string>;
}

const VAZIO: Metacampos = {
  tipo: null,
  docuraTexto: null,
  docuraNivel: null,
  ocasioes: [],
  harmonizacoes: [],
  uvas: [],
  regiao: null,
  temperatura: null,
  corpo: null,
  acidez: null,
  complexidade: null,
  ficha: {},
};

function normalizar(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Um metacampo de lista chega como JSON. Um de texto, como string crua. Alguns
 * chegam como texto único com vírgulas. Os três casos viram lista aqui.
 */
export function valoresDe(metafield: ShopifyMetafield): string[] {
  const bruto = (metafield.value ?? "").trim();
  if (!bruto) return [];

  if (metafield.type.startsWith("list.") || bruto.startsWith("[")) {
    try {
      const parsed = JSON.parse(bruto);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      // JSON malformado: cai no tratamento de texto abaixo.
    }
  }
  return [bruto];
}

function primeiro(metafield: ShopifyMetafield): string | null {
  return valoresDe(metafield)[0] ?? null;
}

function numero(metafield: ShopifyMetafield): number | null {
  const n = Number(primeiro(metafield));
  return Number.isFinite(n) ? n : null;
}

/**
 * Chaves reconhecidas, por fragmento normalizado. A ordem importa: "docura" é
 * prefixo de "docuranivel", então o mais específico vem antes.
 */
const RECONHECIDOS: Array<{ fragmentos: string[]; aplicar: (m: Metacampos, mf: ShopifyMetafield) => void }> = [
  { fragmentos: ["docuranivel", "niveldocura", "docuralevel"], aplicar: (m, mf) => (m.docuraNivel = numero(mf)) },
  { fragmentos: ["docuratexto", "docura", "doceura", "sweetness"], aplicar: (m, mf) => (m.docuraTexto = primeiro(mf)) },
  { fragmentos: ["ocasiao", "ocasioes", "occasion"], aplicar: (m, mf) => (m.ocasioes = valoresDe(mf)) },
  { fragmentos: ["harmonizacao", "harmonizacoes", "pairing"], aplicar: (m, mf) => (m.harmonizacoes = valoresDe(mf)) },
  { fragmentos: ["uvas", "uva", "castas", "grapes"], aplicar: (m, mf) => (m.uvas = valoresDe(mf)) },
  { fragmentos: ["regiao", "region"], aplicar: (m, mf) => (m.regiao = primeiro(mf)) },
  { fragmentos: ["temperatura", "temperature"], aplicar: (m, mf) => (m.temperatura = primeiro(mf)) },
  { fragmentos: ["corpotexto"], aplicar: (m, mf) => (m.corpo = primeiro(mf)) },
  { fragmentos: ["acideztexto"], aplicar: (m, mf) => (m.acidez = primeiro(mf)) },
  { fragmentos: ["complexidadetexto"], aplicar: (m, mf) => (m.complexidade = primeiro(mf)) },
  // "Tipo" é genérico demais para casar por fragmento solto: exige igualdade.
  { fragmentos: ["tipo", "type"], aplicar: (m, mf) => (m.tipo = primeiro(mf)) },
];

/** Metacampos que não viram ficha: longos demais ou já cobertos por outro campo. */
const FORA_DA_FICHA = ["descricaoeditorial", "descricaocurta", "descricao", "metodo"];

export function lerMetacampos(produto: ShopifyProduct): Metacampos {
  const nodes = produto.metafields?.nodes ?? [];
  if (nodes.length === 0) return { ...VAZIO, ficha: {} };

  const resultado: Metacampos = { ...VAZIO, ocasioes: [], harmonizacoes: [], uvas: [], ficha: {} };

  for (const mf of nodes) {
    const chave = normalizar(mf.key);
    const regra = RECONHECIDOS.find((r) =>
      // Para "tipo" e "type" exigimos a chave inteira, não um pedaço: senão
      // "tipodeuva" ou "prototipo" seriam lidos como o tipo do produto.
      r.fragmentos.some((f) => (f === "tipo" || f === "type" ? chave === f : chave.includes(f))),
    );

    if (regra) {
      regra.aplicar(resultado, mf);
      continue;
    }

    if (mf.type.startsWith("number")) continue;
    if (FORA_DA_FICHA.some((f) => chave.includes(f))) continue;

    const valores = valoresDe(mf);
    if (valores.length > 0) resultado.ficha[mf.key] = valores.join(", ");
  }

  return resultado;
}
