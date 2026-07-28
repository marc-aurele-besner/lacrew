/**
 * RuntimeStore: pluggable persistence for issued sessions + proposed intents.
 * Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set, else a bounded
 * in-memory ring — same provider pattern as AuditStore / FlowStore.
 * Metadata only: session private keys never reach the store.
 */

import type { AgentControlRecord } from "./agentControls.js";
import type { Message } from "./conversation.js";
import {
  allAgentControlRows,
  createDb,
  insertMessageRow,
  recentMessageRows,
  getDatabaseUrl,
  insertIntentRow,
  markSessionRevokedRow,
  recentIntentRows,
  recentSessionRows,
  resolveIntentRows,
  upsertAgentControlRow,
  upsertSessionRow,
  type AgentControlRow,
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
  /**
   * Standing per-agent controls — the pause gate and the directive (F1.7).
   * Read once at boot to rehydrate; written through on every change.
   */
  loadAgentControls(): Promise<AgentControlRecord[]>;
  saveAgentControl(record: AgentControlRecord): Promise<void>;
  /** Crew conversation (F1.7) — the third channel, beside intents and proposals. */
  loadMessages(): Promise<Message[]>;
  saveMessage(message: Message): Promise<void>;
  close(): Promise<void>;
}

const MEMORY_MAX = 200;
/** Conversation is read as a thread, so it keeps more history than the event rings. */
const MESSAGE_RING_MAX = 500;

/** Bounded in-memory store so history endpoints work without a database. */
export function createMemoryRuntimeStore(): RuntimeStore {
  const sessions: SessionRecord[] = [];
  const intents: IntentRecord[] = [];
  const controls = new Map<string, AgentControlRecord>();
  const messages: Message[] = [];

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
    // Unbounded on purpose, unlike the rings above: there is one row per agent
    // and an org has tens of them, so trimming would silently drop a directive.
    loadAgentControls: async () => [...controls.values()],
    saveAgentControl: async (record) => {
      controls.set(record.agent, record);
    },
    loadMessages: async () => [...messages],
    saveMessage: async (message) => {
      messages.push(message);
      if (messages.length > MESSAGE_RING_MAX) {
        messages.splice(0, messages.length - MESSAGE_RING_MAX);
      }
    },
    close: async () => {},
  };
}

/** The stored row carries opaque layers; the orchestrator owns their shape. */
function toRow(record: AgentControlRecord): AgentControlRow {
  return { ...record, layers: record.layers as unknown[] };
}

function fromRow(row: AgentControlRow): AgentControlRecord {
  return { ...row, layers: (row.layers ?? []) as AgentControlRecord["layers"] };
}

/** The stored row calls the recipient `recipient`; `to` is the wire name. */
function messageFromRow(row: {
  id: string;
  threadId: string;
  at: string;
  author: string;
  authorKind: string;
  kind: string;
  body: string;
  options?: string[];
  replyTo?: string;
  recipient?: string;
  refs?: unknown[];
}): Message {
  return {
    id: row.id,
    threadId: row.threadId,
    at: row.at,
    author: row.author,
    authorKind: row.authorKind === "human" ? "human" : "agent",
    kind: row.kind as Message["kind"],
    body: row.body,
    ...(row.options?.length ? { options: row.options } : {}),
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    ...(row.recipient ? { to: row.recipient } : {}),
    ...(row.refs?.length ? { refs: row.refs as Message["refs"] } : {}),
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
    loadAgentControls: async () => {
      try {
        return (await allAgentControlRows(db())).map(fromRow);
      } catch (err) {
        // Rethrown, unlike the reads above: hydration is the one call whose
        // empty answer is indistinguishable from "nothing was ever set", and
        // booting every agent unpaused with no directive because the database
        // was briefly unreachable is exactly the silent failure this table
        // exists to prevent. The caller decides what to do about it.
        warn("agent controls load", err);
        throw err;
      }
    },
    saveAgentControl: async (record) => {
      try {
        await upsertAgentControlRow(db(), toRow(record));
      } catch (err) {
        warn("agent control save", err);
      }
    },
    loadMessages: async () => {
      try {
        return (await recentMessageRows(db(), MESSAGE_RING_MAX)).map(messageFromRow);
      } catch (err) {
        // Swallowed, unlike agent controls: an empty conversation is a normal
        // state for a new org, so it cannot be confused with a failed read the
        // way "no agent is paused" could.
        warn("messages load", err);
        return [];
      }
    },
    saveMessage: async (message) => {
      try {
        await insertMessageRow(db(), {
          ...message,
          recipient: message.to,
          refs: message.refs,
        });
      } catch (err) {
        warn("message save", err);
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
