export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} em ${url}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * `fetch` com timeout e erro tipado. Toda integração externa passa por aqui
 * para que uma API lenta não trave um atendimento inteiro.
 */
export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 15_000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpError(504, url, `timeout após ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
