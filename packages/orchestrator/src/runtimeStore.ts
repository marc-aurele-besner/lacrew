/**
 * RuntimeStore: pluggable persistence for issued sessions + proposed intents.
 * Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set, else a bounded
 * in-memory ring — same provider pattern as AuditStore / FlowStore.
 * Metadata only: session private keys never reach the store.
 */

import {
  createDb,
  getDatabaseUrl,
  insertIntentRow,
  markSessionRevokedRow,
  recentIntentRows,
  recentSessionRows,
  resolveIntentRows,
  upsertSessionRow,
  type DbHandle,
  type IntentRow,
  type SessionRow,
} from "@lacrew/db";

export type SessionRecord = SessionRow;
export type IntentRecord = IntentRow;

export interface RuntimeStore {
  readonly name: string;
  /** Upsert a session by keyId; must never throw into the caller's flow. */
  saveSession(record: SessionRecord): Promise<void>;
  markSessionRevoked(keyId: string, revokedAt: string): Promise<void>;
  /** Most recent sessions, newest → oldest. */
  recentSessions(limit: number): Promise<SessionRecord[]>;
  saveIntent(record: IntentRecord): Promise<void>;
  /** Close out pending records for an intent (approved | denied). */
  markIntentResolved(
    intentId: string,
    input: { status: "approved" | "denied"; resolveTxHash?: string; resolvedAt: string },
  ): Promise<void>;
  /** Most recent intents, newest → oldest. */
  recentIntents(limit: number): Promise<IntentRecord[]>;
  close(): Promise<void>;
}

const MEMORY_MAX = 200;

/** Bounded in-memory store so history endpoints work without a database. */
export function createMemoryRuntimeStore(): RuntimeStore {
  const sessions: SessionRecord[] = [];
  const intents: IntentRecord[] = [];

  return {
    name: "memory",
    saveSession: async (record) => {
      const existing = sessions.findIndex((s) => s.keyId === record.keyId);
      if (existing >= 0) sessions[existing] = record;
      else sessions.push(record);
      if (sessions.length > MEMORY_MAX) sessions.splice(0, sessions.length - MEMORY_MAX);
    },
    markSessionRevoked: async (keyId, revokedAt) => {
      const session = sessions.find((s) => s.keyId === keyId);
      if (session) {
        session.status = "revoked";
        session.revokedAt = revokedAt;
      }
    },
    recentSessions: async (limit) => sessions.slice(-limit).reverse(),
    saveIntent: async (record) => {
      intents.push(record);
      if (intents.length > MEMORY_MAX) intents.splice(0, intents.length - MEMORY_MAX);
    },
    markIntentResolved: async (intentId, input) => {
      for (const intent of intents) {
        if (intent.intentId === intentId && intent.status === "pending") {
          intent.status = input.status;
          intent.resolveTxHash = input.resolveTxHash;
          intent.resolvedAt = input.resolvedAt;
        }
      }
    },
    recentIntents: async (limit) => intents.slice(-limit).reverse(),
    close: async () => {},
  };
}

export function createPgRuntimeStore(url = getDatabaseUrl()): RuntimeStore {
  let handle: DbHandle | undefined;
  const db = () => (handle ??= createDb(url));
  const warn = (op: string, err: unknown) =>
    console.error(`[@lacrew/orchestrator] runtime store ${op} failed:`, err);

  return {
    name: "postgres",
    saveSession: async (record) => {
      try {
        await upsertSessionRow(db(), record);
      } catch (err) {
        warn("session save", err);
      }
    },
    markSessionRevoked: async (keyId, revokedAt) => {
      try {
        await markSessionRevokedRow(db(), keyId, revokedAt);
      } catch (err) {
        warn("session revoke", err);
      }
    },
    recentSessions: async (limit) => {
      try {
        return await recentSessionRows(db(), limit);
      } catch (err) {
        warn("sessions list", err);
        return [];
      }
    },
    saveIntent: async (record) => {
      try {
        await insertIntentRow(db(), record);
      } catch (err) {
        warn("intent save", err);
      }
    },
    markIntentResolved: async (intentId, input) => {
      try {
        await resolveIntentRows(db(), intentId, input);
      } catch (err) {
        warn("intent resolve", err);
      }
    },
    recentIntents: async (limit) => {
      try {
        return await recentIntentRows(db(), limit);
      } catch (err) {
        warn("intents list", err);
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
export function createRuntimeStoreFromEnv(): RuntimeStore {
  return getDatabaseUrl() ? createPgRuntimeStore() : createMemoryRuntimeStore();
}
