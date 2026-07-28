/** Query helpers for runtime session/intent records (keeps Drizzle inside @lacrew/db). */

import { and, desc, eq } from "drizzle-orm";
import { runtimeAgentControls, runtimeIntents, runtimeSessions } from "./schema/runtime.js";
import type { DbHandle } from "./client.js";

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
}

export interface IntentRow {
  intentId: string;
  agent: string;
  target: string;
  value: string;
  verdict: string;
  status: string;
  txHash?: string;
  resolveTxHash?: string;
  sessionKeyId?: string;
  chainId?: number;
  proposedAt: string;
  resolvedAt?: string;
}

export async function upsertSessionRow(handle: DbHandle, row: SessionRow): Promise<void> {
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
  };
  await handle.db
    .insert(runtimeSessions)
    .values(values)
    .onConflictDoUpdate({ target: runtimeSessions.keyId, set: values });
}

export async function markSessionRevokedRow(
  handle: DbHandle,
  keyId: string,
  revokedAt: string,
): Promise<void> {
  await handle.db
    .update(runtimeSessions)
    .set({ status: "revoked", revokedAt: new Date(revokedAt) })
    .where(eq(runtimeSessions.keyId, keyId));
}

/** Most recent sessions, newest → oldest. */
export async function recentSessionRows(handle: DbHandle, limit: number): Promise<SessionRow[]> {
  const rows = await handle.db
    .select()
    .from(runtimeSessions)
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
  }));
}

export async function insertIntentRow(handle: DbHandle, row: IntentRow): Promise<void> {
  await handle.db.insert(runtimeIntents).values({
    intentId: row.intentId,
    agent: row.agent,
    target: row.target,
    value: row.value,
    verdict: row.verdict,
    status: row.status,
    txHash: row.txHash ?? null,
    resolveTxHash: row.resolveTxHash ?? null,
    sessionKeyId: row.sessionKeyId ?? null,
    chainId: row.chainId ?? null,
    proposedAt: new Date(row.proposedAt),
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
  });
}

/** Close out pending rows for an intent (approved or denied). */
export async function resolveIntentRows(
  handle: DbHandle,
  intentId: string,
  input: { status: string; resolveTxHash?: string; resolvedAt: string },
): Promise<void> {
  await handle.db
    .update(runtimeIntents)
    .set({
      status: input.status,
      resolveTxHash: input.resolveTxHash ?? null,
      resolvedAt: new Date(input.resolvedAt),
    })
    .where(and(eq(runtimeIntents.intentId, intentId), eq(runtimeIntents.status, "pending")));
}

/** Most recent intents, newest → oldest. */
export async function recentIntentRows(handle: DbHandle, limit: number): Promise<IntentRow[]> {
  const rows = await handle.db
    .select()
    .from(runtimeIntents)
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
    sessionKeyId: row.sessionKeyId ?? undefined,
    chainId: row.chainId ?? undefined,
    proposedAt: row.proposedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString(),
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
export async function upsertAgentControlRow(
  handle: DbHandle,
  row: AgentControlRow,
): Promise<void> {
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
    .values(values)
    .onConflictDoUpdate({ target: runtimeAgentControls.agent, set: values });
}

/**
 * Every agent with standing state.
 *
 * Rows where nothing stands — resumed, directive cleared — are not filtered
 * out here: a caller hydrating in-memory state needs to know the row exists so
 * it does not re-create it, and the shape it reads back says plainly that
 * nothing is set.
 */
export async function allAgentControlRows(handle: DbHandle): Promise<AgentControlRow[]> {
  const rows = await handle.db.select().from(runtimeAgentControls);
  return rows.map((row) => ({
    agent: row.agent,
    paused: row.paused,
    pausedAt: row.pausedAt?.toISOString(),
    pausedReason: row.pausedReason ?? undefined,
    layers: Array.isArray(row.layers) ? row.layers : [],
    updatedAt: row.updatedAt.toISOString(),
  }));
}
