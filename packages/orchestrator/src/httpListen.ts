/**
 * Listen helpers that close cleanly on SIGINT/SIGTERM so tsx watch reloads
 * do not hit EADDRINUSE on the previous process's port.
 */

import type { Server } from "node:http";

export async function listenHttp(
  server: Server,
  port: number,
  onListening: () => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListen);
      if (err.code === "EADDRINUSE") {
        console.error(
          `[@lacrew/orchestrator] port ${port} already in use — stop the other process or set PORT`,
        );
      }
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

export function installShutdownHooks(
  server: Server,
  onStop?: () => Promise<void>,
): void {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[@lacrew/orchestrator] ${signal} — shutting down`);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force-close hangers so watch reloads are not blocked.
      setTimeout(resolve, 2_000).unref();
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
