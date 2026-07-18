/**
 * AuditStore: pluggable persistence for the runtime's ProtocolEvent trail.
 * Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set, else memory no-op —
 * same provider pattern as QueueProvider / ModelProvider.
 */

import {
  createDb,
  getDatabaseUrl,
  insertAuditEvent,
  recentAuditEvents,
  type DbHandle,
} from "@lacrew/db";
import type { ProtocolEvent } from "@lacrew/core";

export interface AuditStore {
  readonly name: string;
  /** Persist one event; must never throw into the caller's flow. */
  append(event: ProtocolEvent): Promise<void>;
  /** Most recent events, oldest → newest (ready to replay into the ring). */
  recent(limit: number): Promise<ProtocolEvent[]>;
  close(): Promise<void>;
}

/** No-op store for mock demos and tests. */
export function createMemoryAuditStore(): AuditStore {
  return {
    name: "memory",
    append: async () => {},
    recent: async () => [],
    close: async () => {},
  };
}

export function createPgAuditStore(url = getDatabaseUrl()): AuditStore {
  let handle: DbHandle | undefined;
  const db = () => (handle ??= createDb(url));

  return {
    name: "postgres",
    append: async (event) => {
      try {
        await insertAuditEvent(db(), event);
      } catch (err) {
        console.error("[@lacrew/orchestrator] audit append failed:", err);
      }
    },
    recent: async (limit) => {
      try {
        const rows = await recentAuditEvents(db(), limit);
        return rows.map((row) => ({
          type: row.type as ProtocolEvent["type"],
          at: row.at,
          ...(row.orgId ? { orgId: row.orgId } : {}),
          payload: row.payload,
        }));
      } catch (err) {
        console.error("[@lacrew/orchestrator] audit recent failed:", err);
        return [];
      }
    },
    close: async () => {
      await handle?.close();
      handle = undefined;
    },
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createAuditStoreFromEnv(): AuditStore {
  return getDatabaseUrl() ? createPgAuditStore() : createMemoryAuditStore();
}
