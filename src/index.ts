import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { app, scheduler } = buildServer(cfg);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "encerrando");
    // Drena os atendimentos em voo antes de fechar, para não cortar uma
    // resposta no meio do envio.
    await scheduler.drain();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
}

main().catch((err) => {
  console.error("Falha ao subir o serviço:", err);
  process.exit(1);
});
