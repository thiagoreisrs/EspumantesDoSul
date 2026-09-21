/**
 * Agrupa mensagens por conversa e garante um atendimento por vez.
 *
 * Dois problemas reais do WhatsApp que isso resolve:
 *  1. o cliente manda "oi", "queria saber do meu pedido", "é o 1234" em três
 *     mensagens — sem agrupar, o agente responde três vezes, mal;
 *  2. webhooks chegam em paralelo — sem trava, duas execuções consultam o ERP
 *     ao mesmo tempo e mandam respostas sobrepostas.
 */
export class ConversationScheduler {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly running = new Map<number, Promise<void>>();
  /** Conversas que receberam mensagem nova enquanto rodavam. */
  private readonly rerun = new Set<number>();

  constructor(
    private readonly debounceMs: number,
    private readonly task: (conversationId: number) => Promise<void>,
    private readonly onError: (conversationId: number, err: unknown) => void,
  ) {}

  /** Registra atividade numa conversa e (re)arma o disparo. */
  schedule(conversationId: number): void {
    const existing = this.timers.get(conversationId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(conversationId);
      void this.dispatch(conversationId);
    }, this.debounceMs);
    // Um timer pendente não deve segurar o processo no shutdown.
    timer.unref?.();
    this.timers.set(conversationId, timer);
  }

  private async dispatch(conversationId: number): Promise<void> {
    if (this.running.has(conversationId)) {
      this.rerun.add(conversationId);
      return;
    }

    const run = (async () => {
      try {
        await this.task(conversationId);
      } catch (err) {
        this.onError(conversationId, err);
      }
    })();

    this.running.set(conversationId, run);
    await run;
    this.running.delete(conversationId);

    if (this.rerun.delete(conversationId)) {
      this.schedule(conversationId);
    }
  }

  /** Espera o que estiver em voo. Usado no encerramento gracioso. */
  async drain(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.running.values()]);
  }
}
