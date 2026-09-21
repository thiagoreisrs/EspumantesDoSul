import { describe, expect, it, vi } from "vitest";
import { ConversationScheduler } from "../src/conversation/scheduler.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ConversationScheduler", () => {
  it("agrupa mensagens seguidas em uma única execução", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ConversationScheduler(30, task, () => {});

    scheduler.schedule(1);
    await tick(10);
    scheduler.schedule(1);
    await tick(10);
    scheduler.schedule(1);

    await tick(80);
    expect(task).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenCalledWith(1);
  });

  it("não roda duas execuções concorrentes na mesma conversa", async () => {
    let ativos = 0;
    let pico = 0;
    const task = vi.fn(async () => {
      ativos += 1;
      pico = Math.max(pico, ativos);
      await tick(40);
      ativos -= 1;
    });
    const scheduler = new ConversationScheduler(10, task, () => {});

    scheduler.schedule(1);
    await tick(20); // primeira execução começou
    scheduler.schedule(1); // chega durante a execução

    await tick(150);
    expect(pico).toBe(1);
    expect(task).toHaveBeenCalledTimes(2); // reexecuta depois, sem sobrepor
  });

  it("isola o erro de uma conversa e o entrega ao callback", async () => {
    const onError = vi.fn();
    const scheduler = new ConversationScheduler(10, async () => {
      throw new Error("boom");
    }, onError);

    scheduler.schedule(7);
    await tick(60);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe(7);
  });

  it("conversas diferentes rodam em paralelo", async () => {
    const vistos: number[] = [];
    const scheduler = new ConversationScheduler(10, async (id) => {
      vistos.push(id);
      await tick(20);
    }, () => {});

    scheduler.schedule(1);
    scheduler.schedule(2);
    await tick(60);

    expect(vistos.sort()).toEqual([1, 2]);
  });
});
