/** Query helpers for runtime session/intent records (keeps Drizzle inside @lacrew/db). */

import { and, desc, eq } from "drizzle-orm";
import {
  runtimeAgentControls,
  runtimeIntents,
  runtimeMessages,
  runtimeSessions,
} from "./schema/runtime.js";
import type { OrgDb } from "./client.js";

export interface SessionRow {
  keyId: string;
  agent: string;
  keyAddress?: string;
  /** AES-256-GCM envelope around the private key; never logged or served. */
  sealedKey?: string | null;
  expiresAt: string;
  scopes: string[];
  maxValue?: string;
  allowedTarget?: string;
  mode: string;
  chainId?: number;
  status: string;
  issuedAt: string;
  revokedAt?: string;
  /** `chain` when absent; a `sandbox` session exists only in the simulator. */
  ledger?: RuntimeLedger;
}

/** Which ledger a session or intent record belongs to. */
export type RuntimeLedger = "chain" | "sandbox";

export interface IntentRow {
  intentId: string;
  agent: string;
  target: string;
  value: string;
  verdict: string;
  status: string;
  txHash?: string;
  resolveTxHash?: string;
  /** Sandbox rows only: the simulator's names for the propose and the resolve. */
  simTxId?: string;
  resolveSimTxId?: string;
  sessionKeyId?: string;
  chainId?: number;
  proposedAt: string;
  resolvedAt?: string;
  /** `chain` when absent; a `sandbox` intent was proposed to the simulator. */
  ledger?: RuntimeLedger;
}

export async function upsertSessionRow(handle: OrgDb, row: SessionRow): Promise<void> {
  const values = {
    keyId: row.keyId,
    agent: row.agent,
    keyAddress: row.keyAddress ?? null,
    sealedKey: row.sealedKey ?? null,
    expiresAt: new Date(row.expiresAt),
    scopes: row.scopes,
    maxValue: row.maxValue ?? null,
    allowedTarget: row.allowedTarget ?? null,
    mode: row.mode,
    chainId: row.chainId ?? null,
    status: row.status,
    issuedAt: new Date(row.issuedAt),
    revokedAt: row.revokedAt ? new Date(row.revokedAt) : null,
    ledger: row.ledger ?? "chain",
  };
  await handle.db
    .insert(runtimeSessions)
    .values({ orgId: handle.orgId, ...values })
    .onConflictDoUpdate({
      target: [runtimeSessions.orgId, runtimeSessions.keyId, runtimeSessions.ledger],
      set: values,
    });
}

export async function markSessionRevokedRow(
  handle: OrgDb,
  keyId: string,
  revokedAt: string,
  ledger: RuntimeLedger = "chain",
): Promise<void> {
  await handle.db
    .update(runtimeSessions)
    .set({ status: "revoked", revokedAt: new Date(revokedAt) })
    .where(
      and(
        eq(runtimeSessions.orgId, handle.orgId),
        eq(runtimeSessions.keyId, keyId),
        eq(runtimeSessions.ledger, ledger),
      ),
    );
}

/** Most recent sessions of one ledger, newest → oldest. */
export async function recentSessionRows(
  handle: OrgDb,
  limit: number,
  ledger: RuntimeLedger = "chain",
): Promise<SessionRow[]> {
  const rows = await handle.db
    .select()
    .from(runtimeSessions)
    .where(and(eq(runtimeSessions.orgId, handle.orgId), eq(runtimeSessions.ledger, ledger)))
    .orderBy(desc(runtimeSessions.issuedAt))
    .limit(limit);
  return rows.map((row) => ({
    keyId: row.keyId,
    agent: row.agent,
    keyAddress: row.keyAddress ?? undefined,
    sealedKey: row.sealedKey ?? undefined,
    expiresAt: row.expiresAt.toISOString(),
    scopes: row.scopes,
    maxValue: row.maxValue ?? undefined,
    allowedTarget: row.allowedTarget ?? undefined,
    mode: row.mode,
    chainId: row.chainId ?? undefined,
    status: row.status,
    issuedAt: row.issuedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    ledger: row.ledger as RuntimeLedger,
  }));
}

export async function insertIntentRow(handle: OrgDb, row: IntentRow): Promise<void> {
  await handle.db.insert(runtimeIntents).values({
    orgId: handle.orgId,
    intentId: row.intentId,
    agent: row.agent,
    target: row.target,
    value: row.value,
    verdict: row.verdict,
    status: row.status,
    txHash: row.txHash ?? null,
    resolveTxHash: row.resolveTxHash ?? null,
    simTxId: row.simTxId ?? null,
    resolveSimTxId: row.resolveSimTxId ?? null,
    sessionKeyId: row.sessionKeyId ?? null,
    chainId: row.chainId ?? null,
    proposedAt: new Date(row.proposedAt),
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
    ledger: row.ledger ?? "chain",
  });
}

/** Close out pending rows for an intent (approved or denied). */
export async function resolveIntentRows(
  handle: OrgDb,
  intentId: string,
  input: {
    status: string;
    resolveTxHash?: string;
    resolveSimTxId?: string;
    resolvedAt: string;
    ledger?: RuntimeLedger;
  },
): Promise<void> {
  await handle.db
    .update(runtimeIntents)
    .set({
      status: input.status,
      resolveTxHash: input.resolveTxHash ?? null,
      resolveSimTxId: input.resolveSimTxId ?? null,
      resolvedAt: new Date(input.resolvedAt),
    })
    .where(
      and(
        eq(runtimeIntents.orgId, handle.orgId),
        eq(runtimeIntents.intentId, intentId),
        eq(runtimeIntents.status, "pending"),
        eq(runtimeIntents.ledger, input.ledger ?? "chain"),
      ),
    );
}

/**
 * Delete every simulated session and intent record. Paired with a sandbox
 * reset; chain records are never touched.
 */
export async function deleteSandboxRuntimeRows(handle: OrgDb): Promise<void> {
  await handle.db
    .delete(runtimeSessions)
    .where(and(eq(runtimeSessions.orgId, handle.orgId), eq(runtimeSessions.ledger, "sandbox")));
  await handle.db
    .delete(runtimeIntents)
    .where(and(eq(runtimeIntents.orgId, handle.orgId), eq(runtimeIntents.ledger, "sandbox")));
}

/** Most recent intents of one ledger, newest → oldest. */
export async function recentIntentRows(
  handle: OrgDb,
  limit: number,
  ledger: RuntimeLedger = "chain",
): Promise<IntentRow[]> {
  const rows = await handle.db
    .select()
    .from(runtimeIntents)
    .where(and(eq(runtimeIntents.orgId, handle.orgId), eq(runtimeIntents.ledger, ledger)))
    .orderBy(desc(runtimeIntents.proposedAt), desc(runtimeIntents.id))
    .limit(limit);
  return rows.map((row) => ({
    intentId: row.intentId,
    agent: row.agent,
    target: row.target,
    value: row.value,
    verdict: row.verdict,
    status: row.status,
    txHash: row.txHash ?? undefined,
    resolveTxHash: row.resolveTxHash ?? undefined,
    simTxId: row.simTxId ?? undefined,
    resolveSimTxId: row.resolveSimTxId ?? undefined,
    sessionKeyId: row.sessionKeyId ?? undefined,
    chainId: row.chainId ?? undefined,
    proposedAt: row.proposedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString(),
    ledger: row.ledger as RuntimeLedger,
  }));
}

/** Standing per-agent controls: the pause gate and the directive layers. */
export interface AgentControlRow {
  agent: string;
  paused: boolean;
  pausedAt?: string;
  pausedReason?: string;
  /** Ordered directive layers, opaque here — @lacrew/orchestrator owns the shape. */
  layers: unknown[];
  updatedAt: string;
}

/**
 * Replace one agent's controls.
 *
 * A directive is edited as a document, so the row is overwritten wholesale
 * rather than merged — a partial update would let a caller that omitted
 * `layers` silently keep a directive it believed it had cleared.
 */
export async function upsertAgentControlRow(handle: OrgDb, row: AgentControlRow): Promise<void> {
  const values = {
    agent: row.agent,
    paused: row.paused,
    pausedAt: row.pausedAt ? new Date(row.pausedAt) : null,
    pausedReason: row.pausedReason ?? null,
    layers: row.layers,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(runtimeAgentControls)
    .values({ orgId: handle.orgId, ...values })
    .onConflictDoUpdate({
      target: [runtimeAgentControls.orgId, runtimeAgentControls.agent],
      set: values,
    });
}

/**
 * Every agent with standing state.
 *
 * Rows where nothing stands — resumed, directive cleared — are not filtered
 * out here: a caller hydrating in-memory state needs to know the row exists so
 * it does not re-create it, and the shape it reads back says plainly that
 * nothing is set.
 */
export async function allAgentControlRows(handle: OrgDb): Promise<AgentControlRow[]> {
  const rows = await handle.db
    .select()
    .from(runtimeAgentControls)
    .where(eq(runtimeAgentControls.orgId, handle.orgId));
  return rows.map((row) => ({
    agent: row.agent,
    paused: row.paused,
    pausedAt: row.pausedAt?.toISOString(),
    pausedReason: row.pausedReason ?? undefined,
    layers: Array.isArray(row.layers) ? row.layers : [],
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** One conversation message. `refs` and `options` stay opaque here. */
export interface MessageRow {
  id: string;
  threadId: string;
  at: string;
  author: string;
  /** Seat id the posting surface authenticated; what a gate is matched on. */
  authorId?: string;
  authorKind: string;
  kind: string;
  body: string;
  options?: string[];
  replyTo?: string;
  recipient?: string;
  refs?: unknown[];
  blocks?: unknown[];
  /** Channel this was bridged in from, when it was not the app. */
  via?: string;
}

/** Insert-only: a message is a statement someone made, and editing one would rewrite the record. */
export async function insertMessageRow(handle: OrgDb, row: MessageRow): Promise<void> {
  await handle.db
    .insert(runtimeMessages)
    .values({
      orgId: handle.orgId,
      id: row.id,
      threadId: row.threadId,
      at: new Date(row.at),
      author: row.author,
      authorId: row.authorId ?? null,
      authorKind: row.authorKind,
      kind: row.kind,
      body: row.body,
      options: row.options ?? null,
      replyTo: row.replyTo ?? null,
      recipient: row.recipient ?? null,
      refs: row.refs ?? null,
      blocks: row.blocks ?? null,
      via: row.via ?? null,
    })
    .onConflictDoNothing();
}

/** Most recent messages, returned oldest → newest so a reader follows them forward. */
export async function recentMessageRows(handle: OrgDb, limit: number): Promise<MessageRow[]> {
  const rows = await handle.db
    .select()
    .from(runtimeMessages)
    .where(eq(runtimeMessages.orgId, handle.orgId))
    .orderBy(desc(runtimeMessages.at), desc(runtimeMessages.id))
    .limit(limit);
  return rows.reverse().map((row) => ({
    id: row.id,
    threadId: row.threadId,
    at: row.at.toISOString(),
    author: row.author,
    authorId: row.authorId ?? undefined,
    authorKind: row.authorKind,
    kind: row.kind,
    body: row.body,
    options: Array.isArray(row.options) ? row.options : undefined,
    replyTo: row.replyTo ?? undefined,
    recipient: row.recipient ?? undefined,
    refs: Array.isArray(row.refs) ? row.refs : undefined,
    blocks: Array.isArray(row.blocks) ? row.blocks : undefined,
    via: row.via ?? undefined,
  }));
}
