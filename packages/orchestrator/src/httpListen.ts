/**
 * Listen helpers that close cleanly on SIGINT/SIGTERM so tsx watch reloads
 * do not hit EADDRINUSE on the previous process's port.
 * Retries briefly — the old process often still holds the port for ~100–500ms.
 */

import type { Server } from "node:http";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function attemptListen(
  server: Server,
  port: number,
  onListening: () => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      server.off("error", onError);
      onListening();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(port);
  });
}

export async function listenHttp(
  server: Server,
  port: number,
  onListening: () => void,
  opts: { retries?: number; retryMs?: number } = {},
): Promise<void> {
  const retries = opts.retries ?? 20;
  const retryMs = opts.retryMs ?? 150;
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await attemptListen(server, port, onListening);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || i === retries - 1) {
        if (code === "EADDRINUSE") {
          console.error(
            `[@lacrew/orchestrator] port ${port} still in use after ${retries} retries — stop the other process or set PORT`,
          );
        }
        throw err;
      }
      await sleep(retryMs);
    }
  }
  throw lastErr;
}

export function installShutdownHooks(
  server: Server,
  onStop?: () => Promise<void>,
): void {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[@lacrew/orchestrator] ${signal} — shutting down`);
    try {
      const s = server as Server & { closeAllConnections?: () => void };
      s.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 1_500).unref();
    });
    try {
      await onStop?.();
    } catch (err) {
      console.error(err);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
