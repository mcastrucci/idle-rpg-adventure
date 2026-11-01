import type { FastifyInstance } from 'fastify';

/** Installs process lifecycle handling only at the executable boundary, never as an import side effect. */
export function installShutdownHandlers(app: FastifyInstance, timeoutMs: number): () => void {
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => { app.log.fatal('shutdown deadline exceeded'); process.exit(1); }, timeoutMs);
    void app.close().then(() => { clearTimeout(deadline); remove(); }, (error: unknown) => {
      clearTimeout(deadline); remove(); app.log.error({ err: error }, 'shutdown failed'); process.exitCode = 1;
    });
  };
  const terminate = (): void => shutdown('SIGTERM');
  const interrupt = (): void => shutdown('SIGINT');
  const remove = (): void => { process.off('SIGTERM', terminate); process.off('SIGINT', interrupt); };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  return remove;
}
