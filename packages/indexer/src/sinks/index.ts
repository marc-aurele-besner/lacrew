import { getDatabaseUrl } from "@lacrew/db";
import { PostgresEventSink } from "./postgres.js";
import type { EventSink, IndexedEvent } from "./types.js";

export { MemoryEventSink } from "./memory.js";
export { PostgresEventSink } from "./postgres.js";
export type { EventSink, IndexedEvent } from "./types.js";

/**
 * Postgres when DATABASE_URL is set, otherwise nothing durable — the JSON
 * store the watcher keeps is the local fallback, not a consumer target.
 */
export function createEventSinksFromEnv(): EventSink[] {
  return getDatabaseUrl() ? [new PostgresEventSink()] : [];
}

/**
 * Fan one event out to every sink. Sinks are asked to swallow their own
 * errors, but a third-party sink that breaks that contract must not stop the
 * others from receiving the event or stop the watcher from indexing.
 */
export async function writeToSinks(
  sinks: readonly EventSink[],
  indexed: IndexedEvent,
): Promise<void> {
  for (const sink of sinks) {
    try {
      await sink.write(indexed);
    } catch (err) {
      console.error(
        `[@lacrew/indexer] sink "${sink.name}" threw:`,
        err instanceof Error ? err.message.split("\n")[0] : err,
      );
    }
  }
}
