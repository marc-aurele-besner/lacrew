/**
 * AuditStore: pluggable persistence for the runtime's ProtocolEvent trail.
 * Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set, else memory no-op —
 * same provider pattern as QueueProvider / ModelProvider.
 */

import {
  assertValidOrgId,
  auditEventsBetween,
  countAuditEventsByAgent,
  countAuditEventsByDay,
  countAuditEventsByType,
  deleteKeyedAuditEvents,
  deleteSandboxAuditEvents,
  getDatabaseUrl,
  insertAuditEvent,
  recentAuditEvents,
  type DbHandle,
} from "@lacrew/db";
import { sharedDb } from "./dbPool.js";
import type { Ledger, ProtocolEvent } from "@lacrew/core";

/** How one event is identified in the store, when it must not be stored twice. */
export interface AuditAppendOptions {
  /**
   * Store the event at most once: a second append under the same key and
   * index is dropped. The key names the fact; the index tells apart several
   * events that share it.
   */
  identity?: { key: string; index: number };
  /**
   * This event is the fuller record of the fact stored under this key: every
   * event appended with that identity is removed before this one is written.
   */
  supersedes?: string;
}

export interface AuditStore {
  readonly name: string;
  /** Persist one event; must never throw into the caller's flow. */
  append(event: ProtocolEvent, options?: AuditAppendOptions): Promise<void>;
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
   * Event counts by UTC day (`YYYY-MM-DD`) × type over `[fromIso, toIso)`,
   * from the full persisted trail; days with no events are absent. Null when
   * the store cannot answer completely, exactly as `countByTypeSince` is.
   */
  countByDayBetween(
    fromIso: string,
    toIso: string,
  ): Promise<Array<{ day: string; type: string; count: number }> | null>;
  /**
   * Event counts by agent (the payload's lower-cased `agent`, null when a row
   * names none) × type over `[fromIso, toIso)`. Null when the store cannot
   * answer completely.
   */
  countByAgentBetween(
    fromIso: string,
    toIso: string,
  ): Promise<Array<{ agent: string | null; type: string; count: number }> | null>;
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
  /**
   * Delete every simulated (`ledger: "sandbox"`) event. Called by a sandbox
   * reset; rows of the chain ledger are never touched.
   */
  clearSandbox(): Promise<void>;
  close(): Promise<void>;
}

/** No-op store for mock demos and tests. */
export function createMemoryAuditStore(): AuditStore {
  return {
    name: "memory",
    append: async () => {},
    recent: async () => [],
    countByTypeSince: async () => null,
    countByDayBetween: async () => null,
    countByAgentBetween: async () => null,
    between: async () => null,
    clearSandbox: async () => {},
    close: async () => {},
  };
}

/**
 * Postgres-backed store, optionally scoped to one chain. When `chainId` is
 * set, rows are stamped with it on write and every read answers only that
 * chain — a testnet orchestrator and a mainnet one can share a database
 * without hydrating or billing from each other's trail. Without it the store
 * reads every chain (mock demos, single-chain deployments).
 *
 * Always scoped to one `ledger`: rows are stamped with it on write and every
 * read and count answers only that ledger, so a sandbox's simulated trail and a
 * chain's real one never hydrate, report or bill from each other.
 */
export function createPgAuditStore(options: {
  db: DbHandle;
  orgId: string;
  chainId?: number;
  ledger?: Ledger;
}): AuditStore {
  const db = () => options.db;
  const { chainId, ledger = "chain" } = options;
  const orgId = assertValidOrgId(options.orgId);
  const scope = chainId === undefined ? { orgId, ledger } : { orgId, chainId, ledger };
  const toEvent = (row: Awaited<ReturnType<typeof recentAuditEvents>>[number]): ProtocolEvent => ({
    type: row.type as ProtocolEvent["type"],
    at: row.at,
    ...(row.chainId == null ? {} : { chainId: row.chainId }),
    ...(row.ledger === "sandbox" ? { ledger: "sandbox" as const } : {}),
    payload: row.payload,
  });

  return {
    name: "postgres",
    append: async (event, options) => {
      try {
        const eventLedger = event.ledger ?? ledger;
        if (options?.supersedes) {
          await deleteKeyedAuditEvents(db(), {
            orgId,
            ledger: eventLedger,
            eventKey: options.supersedes,
          });
        }
        await insertAuditEvent(db(), {
          ...event,
          orgId,
          chainId: event.chainId ?? chainId ?? null,
          ledger: eventLedger,
          ...(options?.identity
            ? { eventKey: options.identity.key, eventIndex: options.identity.index }
            : {}),
        });
      } catch (err) {
        console.error("[@lacrew/orchestrator] audit append failed:", err);
      }
    },
    recent: async (limit) => {
      try {
        const rows = await recentAuditEvents(db(), limit, scope);
        return rows.map(toEvent);
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
    countByDayBetween: async (fromIso, toIso) => {
      try {
        return await countAuditEventsByDay(db(), fromIso, toIso, scope);
      } catch (err) {
        console.error("[@lacrew/orchestrator] audit daily count failed:", err);
        return null;
      }
    },
    countByAgentBetween: async (fromIso, toIso) => {
      try {
        return await countAuditEventsByAgent(db(), fromIso, toIso, scope);
      } catch (err) {
        console.error("[@lacrew/orchestrator] audit agent count failed:", err);
        return null;
      }
    },
    between: async (fromIso, toIso, limit) => {
      try {
        const rows = await auditEventsBetween(db(), fromIso, toIso, limit, scope);
        return {
          events: rows.map(toEvent),
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
    clearSandbox: async () => {
      // Not swallowed: a reset that left the old simulation's trail behind
      // would show it under the new one, and the caller has to be told.
      await deleteSandboxAuditEvents(db(), orgId);
    },
    // The pool belongs to whoever injected it, and is closed there.
    close: async () => {},
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createAuditStoreFromEnv(
  orgId: string,
  chainId?: number,
  ledger: Ledger = "chain",
): AuditStore {
  return getDatabaseUrl()
    ? createPgAuditStore({ db: sharedDb(), orgId, chainId, ledger })
    : createMemoryAuditStore();
}
