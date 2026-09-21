import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_PATH = resolve(process.cwd(), "knowledge/politicas.md");

let cached: string | null = null;

/**
 * Base de conhecimento editável por quem toca a loja, sem precisar de deploy de
 * código. É carregada uma vez e entra no prefixo cacheado do prompt — por isso
 * não relemos o arquivo a cada mensagem.
 */
export function loadKnowledge(path: string = DEFAULT_PATH): string {
  if (cached !== null) return cached;
  try {
    cached = readFileSync(path, "utf8").trim();
  } catch {
    cached =
      "(Base de conhecimento não encontrada. Trate toda pergunta sobre frete, prazo, " +
      "pagamento, troca ou devolução como desconhecida e escale para um humano.)";
  }
  return cached;
}

/** Só para testes: descarta o cache. */
export function resetKnowledgeCache(): void {
  cached = null;
}
