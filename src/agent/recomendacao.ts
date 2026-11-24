import type { ShopifyProduct } from "../shopify/client.js";
import { lerMetacampos } from "../shopify/metacampos.js";

export interface FaixaPreco {
  /** Nenhum produto abaixo disto é oferecido. */
  piso: number;
  /** Nenhum produto acima disto é oferecido. */
  teto: number;
  /** Valor que o cliente citou, quando citou um valor central. */
  alvo: number | null;
}

export interface PedidoDeFaixa {
  /** "quero algo de uns R$150" — valor central, aproximado. */
  precoAlvo?: number | null;
  /** "a partir de R$80" — piso rígido. */
  precoMin?: number | null;
  /** "até R$150" — teto rígido. */
  precoMax?: number | null;
}

/**
 * Converte o que o cliente disse numa faixa de busca.
 *
 * A regra que importa: o piso. Um cliente que fala em R$150 não quer ver
 * rótulos de R$30 — mostrar isso parece que não se escutou o que ele pediu, ou
 * pior, que se duvidou do bolso dele. Já um pouco acima do valor é bem-vindo,
 * porque costuma ser o rótulo melhor que ele toparia levar.
 *
 * Por isso "uns R$150" (valor central) vira R$105 a R$165, enquanto "até
 * R$150" (teto explícito) nunca ultrapassa R$150 — quem põe um limite rígido
 * está falando do que pode gastar, não do que gostaria de beber.
 */
export function montarFaixa(pedido: PedidoDeFaixa): FaixaPreco | null {
  const alvo = normalizar(pedido.precoAlvo);
  const min = normalizar(pedido.precoMin);
  const max = normalizar(pedido.precoMax);

  if (alvo !== null) {
    return { piso: arredondar(alvo * 0.7), teto: arredondar(alvo * 1.1), alvo };
  }
  if (min !== null && max !== null) {
    return { piso: min, teto: max, alvo: arredondar((min + max) / 2) };
  }
  if (max !== null) {
    // Teto é limite de bolso: respeitamos à risca, mas sem descer ao fundo do
    // catálogo — quem diz "até 150" raramente quer o de 25.
    return { piso: arredondar(max * 0.7), teto: max, alvo: null };
  }
  if (min !== null) {
    return { piso: min, teto: Number.POSITIVE_INFINITY, alvo: null };
  }
  return null;
}

function normalizar(valor: number | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  if (!Number.isFinite(valor) || valor <= 0) return null;
  return valor;
}

function arredondar(valor: number): number {
  return Math.round(valor * 100) / 100;
}

export interface VarianteEscolhida {
  nome: string;
  sku: string | null;
  preco: number;
}

/**
 * Preço pelo qual o produto deve ser julgado.
 *
 * Olha variante por variante, e não o `minVariantPrice` do produto: uma caixa
 * de seis garrafas e a unidade são variantes do mesmo produto, e julgar pelo
 * menor preço colocaria uma caixa de R$600 numa conversa sobre R$150.
 */
export function variantePreferida(produto: ShopifyProduct, faixa: FaixaPreco | null): VarianteEscolhida | null {
  const disponiveis = produto.variants.nodes
    .filter((v) => v.availableForSale)
    .map((v) => ({ nome: v.title, sku: v.sku, preco: Number(v.price) }))
    .filter((v) => Number.isFinite(v.preco));

  if (disponiveis.length === 0) return null;
  if (!faixa) return disponiveis[0]!;

  const naFaixa = disponiveis.filter((v) => v.preco >= faixa.piso && v.preco <= faixa.teto);
  if (naFaixa.length === 0) return null;

  const referencia = faixa.alvo ?? faixa.teto;
  return naFaixa.reduce((melhor, atual) =>
    Math.abs(atual.preco - referencia) < Math.abs(melhor.preco - referencia) ? atual : melhor,
  );
}

export interface ProdutoRecomendado {
  produto: ShopifyProduct;
  variante: VarianteEscolhida;
}

export interface ResultadoFiltro {
  dentro: ProdutoRecomendado[];
  /** Quantos foram descartados por ficarem fora da faixa pedida. */
  descartadosPorPreco: number;
  /** O mais barato que existia fora da faixa, para quando nada couber. */
  maisProximoAbaixo: ProdutoRecomendado | null;
}

/**
 * Aplica a faixa e ordena por proximidade do que o cliente pediu.
 *
 * O descarte é feito aqui, e não no prompt, pelo mesmo motivo da verificação de
 * titularidade do pedido: o modelo não deve nem ver a opção de R$30 quando a
 * conversa é sobre R$150.
 */
export function filtrarPorFaixa(
  produtos: ShopifyProduct[],
  faixa: FaixaPreco | null,
  limite = 5,
): ResultadoFiltro {
  const ativos = produtos.filter((p) => p.status === "ACTIVE");

  if (!faixa) {
    const dentro = ativos
      .map((produto) => {
        const variante = variantePreferida(produto, null);
        return variante ? { produto, variante } : null;
      })
      .filter((x): x is ProdutoRecomendado => x !== null);
    return { dentro: dentro.slice(0, limite), descartadosPorPreco: 0, maisProximoAbaixo: null };
  }

  const dentro: ProdutoRecomendado[] = [];
  let descartadosPorPreco = 0;
  let maisProximoAbaixo: ProdutoRecomendado | null = null;

  for (const produto of ativos) {
    const variante = variantePreferida(produto, faixa);
    if (variante) {
      dentro.push({ produto, variante });
      continue;
    }
    const qualquer = variantePreferida(produto, null);
    if (!qualquer) continue;
    descartadosPorPreco += 1;
    // Guarda o mais caro entre os abaixo do piso: é o que menos destoa do pedido.
    if (qualquer.preco < faixa.piso) {
      if (!maisProximoAbaixo || qualquer.preco > maisProximoAbaixo.variante.preco) {
        maisProximoAbaixo = { produto, variante: qualquer };
      }
    }
  }

  const referencia = faixa.alvo ?? faixa.teto;
  dentro.sort((a, b) => Math.abs(a.variante.preco - referencia) - Math.abs(b.variante.preco - referencia));

  return { dentro: dentro.slice(0, limite), descartadosPorPreco, maisProximoAbaixo };
}

/**
 * Estilos que o cliente de fato reconhece e pede. A ordem importa: o mais
 * específico vem primeiro, porque "Extra Brut" e "Brut Nature" contêm "brut".
 */
const ESTILOS: Array<{ rotulo: string; termos: string[] }> = [
  { rotulo: "Nature", termos: ["brut nature", "nature"] },
  { rotulo: "Extra Brut", termos: ["extra brut"] },
  { rotulo: "Brut", termos: ["brut"] },
  { rotulo: "Demi-Sec", termos: ["demi-sec", "demi sec", "meio seco", "meio-seco"] },
  // Nos vinhos finos a secura é marcada assim, na tag e às vezes no título.
  // Nos espumantes ela aparece como Brut/Extra Brut/Nature.
  { rotulo: "Seco", termos: ["seco"] },
  // "moscat" cobre moscatel, moscato e a forma plural moscatéis das coleções.
  { rotulo: "Moscatel", termos: ["moscat"] },
  { rotulo: "Prosecco", termos: ["prosecco"] },
  { rotulo: "Rosé", termos: ["rose"] },
  { rotulo: "Tinto", termos: ["tinto"] },
  { rotulo: "Branco", termos: ["branco"] },
];

function semAcento(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Deduz o estilo do produto.
 *
 * A loja não preenche o campo `productType` do Shopify — ele vem vazio em
 * catálogo real. A informação de estilo mora nas tags ("Moscatel", "Moscato")
 * e no próprio título ("Dalla Costa Espumante Moscatel"), então é de lá que a
 * lemos. Confiar em `productType` deixaria o agente sem nada para oferecer na
 * hora de perguntar "seco ou doce?".
 */
export function classificarEstilos(produto: ShopifyProduct): string[] {
  const meta = lerMetacampos(produto);
  // O metacampo "Tipo" ("Vinho Fino Tinto Seco") é a fonte boa. A doçura NÃO
  // entra aqui: a loja usa "Brut" como nível de doçura mesmo em tinto, e quem
  // pede "um brut" quer espumante, não um Tannat.
  const fonte = semAcento(
    [produto.title, meta.tipo ?? "", produto.productType ?? "", ...produto.tags].join(" | "),
  );

  const achados: string[] = [];
  for (const { rotulo, termos } of ESTILOS) {
    if (termos.some((t) => fonte.includes(semAcento(t)))) achados.push(rotulo);
  }

  // "meio seco" contém "seco": sem isto, um demi-sec entraria como seco, que é
  // justamente o oposto.
  const semContradicao = achados.includes("Demi-Sec") ? achados.filter((e) => e !== "Seco") : achados;

  // "Extra Brut" e "Nature" são tipos de brut; manter os dois confundiria.
  if (semContradicao.includes("Nature") || semContradicao.includes("Extra Brut")) {
    return semContradicao.filter((e) => e !== "Brut");
  }
  return semContradicao;
}

/**
 * Como o cliente fala, traduzido para o que o rótulo diz.
 *
 * O cliente responde "seco" ou "doce" — é assim que o agente pergunta. Mas a
 * loja marca isso de dois jeitos diferentes: os vinhos finos levam a tag
 * "Seco", enquanto nos espumantes a mesma ideia aparece como Brut, Extra Brut
 * ou Nature. Sem esta tradução, a resposta mais provável do cliente traria só
 * metade do catálogo que serve para ele.
 */
const SINONIMOS: Array<{ rotulo: "seco" | "doce"; termos: string[]; estilos: string[] }> = [
  {
    rotulo: "seco",
    termos: ["seco", "mais seco", "bem seco", "dry", "menos doce", "nao doce"],
    estilos: ["Seco", "Brut", "Extra Brut", "Nature"],
  },
  {
    rotulo: "doce",
    termos: ["doce", "docinho", "adocicado", "mais doce", "suave", "dulce"],
    estilos: ["Moscatel", "Demi-Sec"],
  },
];

/** Vocabulário que a loja usa no metacampo de doçura, do mais seco ao mais doce. */
const DOCURA_SECA = ["nature", "extra brut", "brut", "seco"];
const DOCURA_DOCE = ["moscatel", "moscato", "demi", "suave", "doce", "meio seco"];

/**
 * Limiares da escala numérica de doçura da loja (0 a 100; o Guatambu seco
 * marca 5). O texto é consultado antes, porque é o dado que a loja escreve à
 * mão; estes números são a segunda opção e o ponto a ajustar se a escala
 * mudar.
 */
const DOCURA_NIVEL_SECO = 25;
const DOCURA_NIVEL_DOCE = 45;

/**
 * Responde "seco ou doce?" pelo metacampo de doçura, que é a fonte boa.
 * Devolve null quando o produto não tem o dado — aí quem decide é a tag.
 */
function docuraCombina(produto: ShopifyProduct, querSeco: "seco" | "doce"): boolean | null {
  const meta = lerMetacampos(produto);

  if (meta.docuraTexto) {
    const texto = semAcento(meta.docuraTexto);
    const ehSeco = DOCURA_SECA.some((t) => texto.includes(semAcento(t)));
    const ehDoce = DOCURA_DOCE.some((t) => texto.includes(semAcento(t)));
    // "meio seco" contém "seco": doce vence, porque é o mais específico.
    if (ehDoce) return querSeco === "doce";
    if (ehSeco) return querSeco === "seco";
  }

  if (meta.docuraNivel !== null) {
    if (meta.docuraNivel <= DOCURA_NIVEL_SECO) return querSeco === "seco";
    if (meta.docuraNivel >= DOCURA_NIVEL_DOCE) return querSeco === "doce";
    return false; // meio-termo não é nem uma coisa nem outra
  }

  return null;
}

/** O produto serve para a ocasião, o prato ou a uva que o cliente citou? */
export function combinaComTexto(produto: ShopifyProduct, campo: "ocasioes" | "harmonizacoes" | "uvas", pedido: string): boolean {
  const alvo = semAcento(pedido).trim();
  if (!alvo) return true;
  const valores = lerMetacampos(produto)[campo];
  if (valores.length === 0) return false;
  return valores.some((v) => {
    const normalizado = semAcento(v);
    return normalizado.includes(alvo) || alvo.includes(normalizado);
  });
}

/** O estilo pedido pelo cliente bate com o que o produto é? */
export function combinaComEstilo(produto: ShopifyProduct, estiloPedido: string): boolean {
  const pedido = semAcento(estiloPedido).trim();
  if (!pedido) return true;

  const estilos = classificarEstilos(produto);

  // Sinônimo decide sozinho: "seco" NÃO pode cair na rede de segurança abaixo
  // e casar com "meio seco", que é justamente o oposto.
  const grupo = SINONIMOS.find((g) => g.termos.some((t) => t === pedido));
  if (grupo) {
    const doMetacampo = docuraCombina(produto, grupo.rotulo);
    if (doMetacampo !== null) return doMetacampo;
    return estilos.some((e) => grupo.estilos.includes(e));
  }

  const normalizados = estilos.map(semAcento);
  if (normalizados.some((e) => e === pedido || e.includes(pedido) || pedido.includes(e))) return true;

  // Rede de segurança: o cliente pode usar uma palavra que não está no
  // vocabulário, mas que aparece no título ou nas tags do produto.
  const fonte = semAcento([produto.title, ...produto.tags].join(" | "));
  return fonte.includes(pedido);
}

export interface Facetas {
  vinicolas: string[];
  tipos: string[];
  ocasioes: string[];
  precoMin: number | null;
  precoMax: number | null;
}

/**
 * O que existe no catálogo para este termo. Alimenta as perguntas de
 * qualificação: sem isto o agente perguntaria "qual vinícola?" sem saber quais
 * ele tem para oferecer.
 */
export function levantarFacetas(produtos: ShopifyProduct[]): Facetas {
  const vinicolas = new Set<string>();
  const tipos = new Set<string>();
  const ocasioes = new Set<string>();
  let precoMin: number | null = null;
  let precoMax: number | null = null;

  for (const produto of produtos) {
    if (produto.status !== "ACTIVE") continue;
    if (produto.vendor) vinicolas.add(produto.vendor);
    for (const estilo of classificarEstilos(produto)) tipos.add(estilo);
    for (const ocasiao of lerMetacampos(produto).ocasioes) ocasioes.add(ocasiao);
    for (const variante of produto.variants.nodes) {
      if (!variante.availableForSale) continue;
      const preco = Number(variante.price);
      if (!Number.isFinite(preco)) continue;
      precoMin = precoMin === null ? preco : Math.min(precoMin, preco);
      precoMax = precoMax === null ? preco : Math.max(precoMax, preco);
    }
  }

  return {
    vinicolas: [...vinicolas].sort(),
    tipos: [...tipos].sort(),
    ocasioes: [...ocasioes].sort(),
    precoMin,
    precoMax,
  };
}
