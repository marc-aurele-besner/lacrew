/**
 * AuditStore: pluggable persistence for the runtime's ProtocolEvent trail.
 * Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set, else memory no-op —
 * same provider pattern as QueueProvider / ModelProvider.
 */

import {
  auditEventsBetween,
  countAuditEventsByType,
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
  /**
   * Event counts by type since `sinceIso`, over the full persisted trail.
   * Null when the store cannot answer completely (memory store, or a read
   * failure) — the caller falls back to its bounded ring and must say so,
   * because a partial count served as a total is a billing lie.
   */
  countByTypeSince(sinceIso: string): Promise<Record<string, number> | null>;
  /**
   * Every event in `[fromIso, toIso)`, newest first — what a period report
   * (F2.33) folds its onchain and connector lines from.
   *
   * Null when this store cannot answer the window at all (memory store, or a
   * read failure); the caller then falls back to its bounded ring and says the
   * figures are partial. `complete: false` on a returned window means the row
   * cap was hit, so the answer is a prefix rather than the period.
   */
  between(
    fromIso: string,
    toIso: string,
    limit: number,
  ): Promise<{ events: ProtocolEvent[]; complete: boolean } | null>;
  close(): Promise<void>;
}

/** No-op store for mock demos and tests. */
export function createMemoryAuditStore(): AuditStore {
  return {
    name: "memory",
    append: async () => {},
    recent: async () => [],
    countByTypeSince: async () => null,
    between: async () => null,
    close: async () => {},
  };
}

/**
 * Postgres-backed store, optionally scoped to one chain. When `chainId` is
 * set, rows are stamped with it on write and every read answers only that
 * chain — a testnet orchestrator and a mainnet one can share a database
 * without hydrating or billing from each other's trail. Without it the store
 * reads the whole table (mock demos, single-chain deployments).
 */
export function createPgAuditStore(url = getDatabaseUrl(), chainId?: number): AuditStore {
  let handle: DbHandle | undefined;
  const db = () => (handle ??= createDb(url));
  const scope = chainId === undefined ? undefined : { chainId };

  return {
    name: "postgres",
    append: async (event) => {
      try {
        await insertAuditEvent(db(), { ...event, chainId: event.chainId ?? chainId ?? null });
      } catch (err) {
        console.error("[@lacrew/orchestrator] audit append failed:", err);
      }
    },
    recent: async (limit) => {
      try {
        const rows = await recentAuditEvents(db(), limit, scope);
        return rows.map((row) => ({
          type: row.type as ProtocolEvent["type"],
          at: row.at,
          ...(row.chainId == null ? {} : { chainId: row.chainId }),
          ...(row.orgId ? { orgId: row.orgId } : {}),
          payload: row.payload,
        }));
      } catch (err) {
        console.error("[@lacrew/orchestrator] audit recent failed:", err);
        return [];
      }
    },
    countByTypeSince: async (sinceIso) => {
      try {
        const rows = await countAuditEventsByType(db(), sinceIso, scope);
        return Object.fromEntries(rows.map((row) => [row.type, row.count]));
      } catch (err) {
        console.error("[@lacrew/orchestrator] audit count failed:", err);
        return null;
      }
    },
    between: async (fromIso, toIso, limit) => {
      try {
        const rows = await auditEventsBetween(db(), fromIso, toIso, limit, scope);
        return {
          events: rows.map((row) => ({
            type: row.type as ProtocolEvent["type"],
            at: row.at,
            ...(row.chainId == null ? {} : { chainId: row.chainId }),
            ...(row.orgId ? { orgId: row.orgId } : {}),
            payload: row.payload,
          })),
          // A window that filled the cap was cut short, and a cut window is a
          // prefix of the period rather than the period.
          complete: rows.length < limit,
        };
      } catch (err) {
        // Null, not []: an unreadable trail is not a quiet period, and the
        // caller has to be able to tell the reader which one it is.
        console.error("[@lacrew/orchestrator] audit range read failed:", err);
        return null;
      }
    },
    close: async () => {
      await handle?.close();
      handle = undefined;
    },
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createAuditStoreFromEnv(chainId?: number): AuditStore {
  return getDatabaseUrl() ? createPgAuditStore(getDatabaseUrl(), chainId) : createMemoryAuditStore();
}
