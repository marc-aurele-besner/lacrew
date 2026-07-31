/**
 * RuntimeStore: pluggable persistence for issued sessions + proposed intents.
 * Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set, else a bounded
 * in-memory ring — same provider pattern as AuditStore / FlowStore.
 * Metadata only: session private keys never reach the store.
 */

import type { AgentControlRecord } from "./agentControls.js";
import type { ConnectorAskRecord, ConnectorAskStore } from "./connectorAsks.js";
import type { HumanGateRecord, HumanGateStore } from "./humanGates.js";
import type { ConnectorModeRecord, ConnectorModeScope, ConnectorModeStore } from "./connectorPolicy.js";
import {
  externalMcpScopeKey,
  type ExternalMcpScope,
  type ExternalMcpStore,
  type ExternalMcpToolRecord,
} from "./externalMcp.js";
import type { Message } from "./conversation.js";
import {
  allAgentControlRows,
  createDb,
  deleteConnectorMode,
  deleteExternalMcpTool,
  insertMessageRow,
  listConnectorModes,
  listExternalMcpTools,
  recentConnectorAsks,
  recentHumanGates,
  recentMessageRows,
  getDatabaseUrl,
  insertIntentRow,
  markSessionRevokedRow,
  recentIntentRows,
  recentSessionRows,
  resolveIntentRows,
  upsertAgentControlRow,
  upsertConnectorAsk,
  upsertConnectorMode,
  upsertExternalMcpTool,
  upsertHumanGate,
  upsertSessionRow,
  type AgentControlRow,
  type ConnectorAskRow,
  type DbHandle,
  type HumanGateRow,
  type IntentRow,
  type SessionRow,
} from "@lacrew/db";

export type SessionRecord = SessionRow;
export type IntentRecord = IntentRow;


export interface RuntimeStore
  extends ConnectorModeStore,
    ConnectorAskStore,
    HumanGateStore,
    ExternalMcpStore {
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

/**
 * Asks kept across a restart.
 *
 * Larger than the event rings because the resolved ones matter as much as the
 * pending ones: a spent "yes" that fell out of the store is a confirmation the
 * next run could spend again.
 */
const ASK_RING_MAX = 500;

const MEMORY_MAX = 200;
/** Conversation is read as a thread, so it keeps more history than the event rings. */
const MESSAGE_RING_MAX = 500;

/** Bounded in-memory store so history endpoints work without a database. */
export function createMemoryRuntimeStore(): RuntimeStore {
  const sessions: SessionRecord[] = [];
  const intents: IntentRecord[] = [];
  const controls = new Map<string, AgentControlRecord>();
  const messages: Message[] = [];
  const connectorModes = new Map<string, ConnectorModeRecord>();
  const connectorAsks = new Map<string, ConnectorAskRecord>();
  const humanGates = new Map<string, HumanGateRecord>();
  const externalMcpTools = new Map<string, ExternalMcpToolRecord>();

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
    loadConnectorModes: async () => [...connectorModes.values()],
    saveConnectorMode: async (record) => {
      connectorModes.set(modeKey(record.scope, record.route), record);
    },
    removeConnectorMode: async (scopeKey, route) => {
      connectorModes.delete(`${scopeKey}|${route}`);
    },
    // Unbounded, like agent controls: there is one row per admitted tool, and
    // trimming would silently un-admit one — or drop a `*` deny, which is worse.
    loadExternalMcpTools: async () => [...externalMcpTools.values()],
    saveExternalMcpTool: async (record) => {
      externalMcpTools.set(mcpToolKey(record.scope, record.server, record.tool), record);
    },
    removeExternalMcpTool: async (scopeKey, server, tool) => {
      externalMcpTools.delete(`${scopeKey}|${server.trim().toLowerCase()}|${tool}`);
    },
    loadConnectorAsks: async () => [...connectorAsks.values()],
    saveConnectorAsk: async (record) => {
      connectorAsks.set(record.id, record);
      if (connectorAsks.size > ASK_RING_MAX) {
        // Insertion order: the oldest ask is the first key, and an ask old
        // enough to fall off has long since expired.
        const oldest = connectorAsks.keys().next().value;
        if (oldest) connectorAsks.delete(oldest);
      }
    },
    loadHumanGates: async () => [...humanGates.values()],
    saveHumanGate: async (record) => {
      humanGates.set(record.id, record);
      if (humanGates.size > ASK_RING_MAX) {
        const oldest = humanGates.keys().next().value;
        if (oldest) humanGates.delete(oldest);
      }
    },
    close: async () => {},
  };
}

/** Same key the Postgres unique constraint uses, so the two agree on identity. */
function scopeKeyOf(scope: ConnectorModeScope): string {
  return scope.level === "workspace"
    ? "workspace"
    : `${scope.level}:${scope.ref.trim().toLowerCase()}`;
}

function modeKey(scope: ConnectorModeScope, route: string): string {
  return `${scopeKeyOf(scope)}|${route}`;
}

/** Same identity the Postgres unique constraint uses (scope + server + tool). */
function mcpToolKey(scope: ExternalMcpScope, server: string, tool: string): string {
  return `${externalMcpScopeKey(scope)}|${server.trim().toLowerCase()}|${tool}`;
}

function modeScopeFromRow(raw: unknown): ConnectorModeScope | null {
  const level = (raw as { level?: unknown } | null)?.level;
  const ref = (raw as { ref?: unknown } | null)?.ref;
  if (level === "workspace") return { level: "workspace" };
  if ((level === "crew" || level === "agent") && typeof ref === "string" && ref.trim()) {
    return { level, ref };
  }
  return null;
}

/** Exported shape ↔ row. The resume state rides as opaque JSON both ways. */
function askToRow(record: ConnectorAskRecord): ConnectorAskRow {
  return {
    id: record.id,
    connector: record.connector,
    route: record.route,
    method: record.method,
    path: record.path,
    fingerprint: record.fingerprint,
    args: record.args,
    principal: record.principal,
    threadId: record.threadId,
    questionId: record.questionId,
    flowId: record.flowId ?? null,
    runId: record.runId ?? null,
    status: record.status,
    outcome: record.outcome ?? null,
    resume: (record.resume as unknown as Record<string, unknown> | undefined) ?? null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    resolvedAt: record.resolvedAt ?? null,
  };
}

function askFromRow(row: ConnectorAskRow): ConnectorAskRecord {
  return {
    id: row.id,
    connector: row.connector,
    route: row.route,
    method: row.method,
    path: row.path,
    fingerprint: row.fingerprint,
    args: row.args ?? {},
    principal: row.principal,
    threadId: row.threadId,
    questionId: row.questionId,
    ...(row.flowId ? { flowId: row.flowId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    status: row.status as ConnectorAskRecord["status"],
    ...(row.outcome ? { outcome: row.outcome as ConnectorAskRecord["outcome"] } : {}),
    ...(row.resume ? { resume: row.resume as unknown as ConnectorAskRecord["resume"] } : {}),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
  };
}

/** Same shape both ways; the resume state rides as opaque JSON. */
function gateToRow(record: HumanGateRecord): HumanGateRow {
  return {
    id: record.id,
    flowId: record.flowId ?? null,
    runId: record.runId ?? null,
    stepId: record.stepId,
    prompt: record.prompt,
    options: record.options as unknown as Array<Record<string, unknown>>,
    assignee: record.assignee ?? null,
    principal: record.principal,
    threadId: record.threadId,
    questionId: record.questionId,
    status: record.status,
    outcome: record.outcome ?? null,
    optionId: record.optionId ?? null,
    answeredBy: record.answeredBy ?? null,
    resume: (record.resume as unknown as Record<string, unknown> | undefined) ?? null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    resolvedAt: record.resolvedAt ?? null,
  };
}

function gateFromRow(row: HumanGateRow): HumanGateRecord {
  return {
    id: row.id,
    ...(row.flowId ? { flowId: row.flowId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    stepId: row.stepId,
    prompt: row.prompt,
    options: (row.options ?? []) as unknown as HumanGateRecord["options"],
    ...(row.assignee ? { assignee: row.assignee } : {}),
    principal: row.principal,
    threadId: row.threadId,
    questionId: row.questionId,
    status: row.status as HumanGateRecord["status"],
    ...(row.outcome ? { outcome: row.outcome as HumanGateRecord["outcome"] } : {}),
    ...(row.optionId ? { optionId: row.optionId } : {}),
    ...(row.answeredBy ? { answeredBy: row.answeredBy } : {}),
    ...(row.resume ? { resume: row.resume as unknown as HumanGateRecord["resume"] } : {}),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
  };
}

/** The stored row carries opaque layers; the orchestrator owns their shape. */
function toRow(record: AgentControlRecord): AgentControlRow {
  return { ...record, layers: record.layers as unknown[] };
}

function fromRow(row: AgentControlRow): AgentControlRecord {
  return { ...row, layers: (row.layers ?? []) as AgentControlRecord["layers"] };
}

/** Every column a message occupies. Exported so the mapping below is testable. */
export type StoredMessageRow = {
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
  blocks?: unknown[];
};

/**
 * Row → message.
 *
 * Exported with `messageToRow` so the pair can be round-tripped in a test. They
 * were not, and a field added to `Message` reached the database schema while
 * this mapping kept dropping it — silently, because the memory store holds the
 * object whole and every test used that one.
 */
export function messageFromRow(row: StoredMessageRow): Message {
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
    ...(row.blocks?.length ? { blocks: row.blocks as Message["blocks"] } : {}),
  };
}

/** Message → row. The stored column is `recipient`; `to` is the wire name. */
export function messageToRow(message: Message): StoredMessageRow {
  return {
    id: message.id,
    threadId: message.threadId,
    at: message.at,
    author: message.author,
    authorKind: message.authorKind,
    kind: message.kind,
    body: message.body,
    ...(message.options?.length ? { options: message.options } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.to ? { recipient: message.to } : {}),
    ...(message.refs?.length ? { refs: message.refs } : {}),
    ...(message.blocks?.length ? { blocks: message.blocks } : {}),
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
        await insertMessageRow(db(), messageToRow(message));
      } catch (err) {
        warn("message save", err);
      }
    },
    loadConnectorModes: async () => {
      try {
        const rows = await listConnectorModes(db());
        return rows.flatMap((row) => {
          const scope = modeScopeFromRow(row.scope);
          // A row whose scope no longer parses is one this build cannot honour.
          // Dropping it silently would apply "no rule" — which is `auto` — so
          // it is reported instead.
          if (!scope) {
            warn("connector mode load", new Error(`unreadable scope: ${JSON.stringify(row.scope)}`));
            return [];
          }
          return [{ scope, route: row.route, mode: row.mode as ConnectorModeRecord["mode"], at: row.updatedAt }];
        });
      } catch (err) {
        // Rethrown, like agent controls: an empty answer here reads as "nothing
        // was ever narrowed", which would put every ask-mode write back on
        // `auto` because a database was briefly unreachable.
        warn("connector modes load", err);
        throw err;
      }
    },
    saveConnectorMode: async (record) => {
      try {
        await upsertConnectorMode(db(), {
          scopeKey: scopeKeyOf(record.scope),
          scope: record.scope as unknown as Record<string, unknown>,
          route: record.route,
          mode: record.mode,
          updatedAt: record.at,
        });
      } catch (err) {
        warn("connector mode save", err);
      }
    },
    removeConnectorMode: async (scopeKey, route) => {
      try {
        await deleteConnectorMode(db(), scopeKey, route);
      } catch (err) {
        warn("connector mode delete", err);
      }
    },
    loadExternalMcpTools: async () => {
      try {
        const rows = await listExternalMcpTools(db());
        return rows.flatMap((row) => {
          const scope = modeScopeFromRow(row.scope);
          if (!scope) {
            warn(
              "external mcp tool load",
              new Error(`unreadable scope: ${JSON.stringify(row.scope)}`),
            );
            return [];
          }
          return [
            {
              scope,
              server: row.server,
              tool: row.tool,
              enabled: row.enabled,
              ...(row.effect === "read" || row.effect === "write" ? { effect: row.effect } : {}),
              ...(row.mode ? { mode: row.mode as ExternalMcpToolRecord["mode"] } : {}),
              ...(row.description ? { description: row.description } : {}),
              ...(row.discoveredAt ? { discoveredAt: row.discoveredAt } : {}),
              at: row.updatedAt,
            } satisfies ExternalMcpToolRecord,
          ];
        });
      } catch (err) {
        // Rethrown, like connector modes: an empty allowlist reads as "no tool
        // was ever admitted", which is the safe direction for *calls* — but the
        // caller must be able to say the list is unreadable rather than serve an
        // operator a tools page claiming they enabled nothing.
        warn("external mcp tools load", err);
        throw err;
      }
    },
    saveExternalMcpTool: async (record) => {
      try {
        await upsertExternalMcpTool(db(), {
          scopeKey: externalMcpScopeKey(record.scope),
          scope: record.scope as unknown as Record<string, unknown>,
          server: record.server,
          tool: record.tool,
          enabled: record.enabled,
          effect: record.effect ?? null,
          mode: record.mode ?? null,
          description: record.description ?? null,
          discoveredAt: record.discoveredAt ?? null,
          updatedAt: record.at,
        });
      } catch (err) {
        warn("external mcp tool save", err);
      }
    },
    removeExternalMcpTool: async (scopeKey, server, tool) => {
      try {
        await deleteExternalMcpTool(db(), scopeKey, server, tool);
      } catch (err) {
        warn("external mcp tool delete", err);
      }
    },
    loadConnectorAsks: async () => {
      try {
        return (await recentConnectorAsks(db(), ASK_RING_MAX)).map(askFromRow);
      } catch (err) {
        // Rethrown for the same reason: with no asks loaded, a spent "yes"
        // looks like a question that was never asked, and the next call would
        // mint a fresh one instead of refusing to spend it twice.
        warn("connector asks load", err);
        throw err;
      }
    },
    saveConnectorAsk: async (record) => {
      try {
        await upsertConnectorAsk(db(), askToRow(record));
      } catch (err) {
        warn("connector ask save", err);
      }
    },
    loadHumanGates: async () => {
      try {
        return (await recentHumanGates(db(), ASK_RING_MAX)).map(gateFromRow);
      } catch (err) {
        // Rethrown: with no gates loaded, a decision someone already made looks
        // like a question that was never asked, and the parked run would be
        // asked again — after the person who answered has gone home.
        warn("human gates load", err);
        throw err;
      }
    },
    saveHumanGate: async (record) => {
      try {
        await upsertHumanGate(db(), gateToRow(record));
      } catch (err) {
        warn("human gate save", err);
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
