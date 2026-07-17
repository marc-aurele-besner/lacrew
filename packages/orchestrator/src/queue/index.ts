import { getDatabaseUrl } from "@lacrew/db";
import { InMemoryQueue } from "./memory.js";
import { PgBossQueue } from "./pg-boss.js";
import type { QueueProvider } from "./types.js";

export type { QueueProvider, QueueHandlers, QueueJobName, QueueStatus } from "./types.js";
export { InMemoryQueue } from "./memory.js";
export { PgBossQueue } from "./pg-boss.js";

/** pg-boss when DATABASE_URL is set; otherwise in-memory (demo default). */
export function createQueueFromEnv(): QueueProvider {
  if (getDatabaseUrl()) return new PgBossQueue();
  return new InMemoryQueue();
}
