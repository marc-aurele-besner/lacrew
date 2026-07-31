/** Query helpers for dual control (keeps Drizzle inside @lacrew/db). */

import { desc, eq } from "drizzle-orm";
import { dualControlReviews, dualControlRules } from "./schema/dualControl.js";
import type { DbHandle } from "./client.js";

export interface DualControlRuleRow {
  scopeKey: string;
  scope: Record<string, unknown>;
  mode: string;
  reviewer: string;
  minSpend: string;
  connectorWrites: boolean;
  orgMutators: boolean;
  timeoutMs: number;
  updatedAt: string;
}

export async function upsertDualControlRule(
  handle: DbHandle,
  row: DualControlRuleRow,
): Promise<void> {
  const values = {
    scopeKey: row.scopeKey,
    scope: row.scope,
    mode: row.mode,
    reviewer: row.reviewer,
    minSpend: row.minSpend,
    connectorWrites: row.connectorWrites,
    orgMutators: row.orgMutators,
    timeoutMs: row.timeoutMs,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(dualControlRules)
    .values(values)
    .onConflictDoUpdate({ target: dualControlRules.scopeKey, set: values });
}

export async function deleteDualControlRule(handle: DbHandle, scopeKey: string): Promise<void> {
  await handle.db.delete(dualControlRules).where(eq(dualControlRules.scopeKey, scopeKey));
}

/**
 * Every rule. Unbounded, like the connector modes: there is one row per scope
 * an operator configured, and a trimmed row is a crew that silently stops
 * needing a second pair of eyes.
 */
export async function listDualControlRules(handle: DbHandle): Promise<DualControlRuleRow[]> {
  const rows = await handle.db.select().from(dualControlRules);
  return rows.map((row) => ({
    scopeKey: row.scopeKey,
    scope: row.scope ?? {},
    mode: row.mode,
    reviewer: row.reviewer,
    minSpend: row.minSpend,
    connectorWrites: row.connectorWrites,
    orgMutators: row.orgMutators,
    timeoutMs: row.timeoutMs,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export interface DualControlReviewRow {
  id: string;
  tool: string;
  effect: string;
  fingerprint: string;
  args: Record<string, unknown>;
  value?: string | null;
  actor: string;
  reviewer: string;
  reviewers: string[];
  human: boolean;
  escalated: boolean;
  humanOverride: boolean;
  threadId: string;
  questionId: string;
  flowId?: string | null;
  runId?: string | null;
  status: string;
  outcome?: string | null;
  decidedBy?: string | null;
  decidedByKind?: string | null;
  resume?: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
}

export async function upsertDualControlReview(
  handle: DbHandle,
  row: DualControlReviewRow,
): Promise<void> {
  const values = {
    id: row.id,
    tool: row.tool,
    effect: row.effect,
    fingerprint: row.fingerprint,
    args: row.args,
    value: row.value ?? null,
    actor: row.actor,
    reviewer: row.reviewer,
    reviewers: row.reviewers,
    human: row.human,
    escalated: row.escalated,
    humanOverride: row.humanOverride,
    threadId: row.threadId,
    questionId: row.questionId,
    flowId: row.flowId ?? null,
    runId: row.runId ?? null,
    status: row.status,
    outcome: row.outcome ?? null,
    decidedBy: row.decidedBy ?? null,
    decidedByKind: row.decidedByKind ?? null,
    resume: row.resume ?? null,
    createdAt: new Date(row.createdAt),
    expiresAt: new Date(row.expiresAt),
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
  };
  await handle.db
    .insert(dualControlReviews)
    .values(values)
    .onConflictDoUpdate({ target: dualControlReviews.id, set: values });
}

/**
 * Every review, newest first, bounded.
 *
 * Resolved reviews load too, not only open ones: the record of a decision the
 * run already acted on is what stops a restart from replaying a released
 * effect, so dropping them at hydration would reopen exactly the hole the
 * deterministic id closes.
 */
export async function recentDualControlReviews(
  handle: DbHandle,
  limit: number,
): Promise<DualControlReviewRow[]> {
  const rows = await handle.db
    .select()
    .from(dualControlReviews)
    .orderBy(desc(dualControlReviews.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    tool: row.tool,
    effect: row.effect,
    fingerprint: row.fingerprint,
    args: row.args ?? {},
    value: row.value,
    actor: row.actor,
    reviewer: row.reviewer,
    reviewers: row.reviewers ?? [],
    human: row.human,
    escalated: row.escalated,
    humanOverride: row.humanOverride,
    threadId: row.threadId,
    questionId: row.questionId,
    flowId: row.flowId,
    runId: row.runId,
    status: row.status,
    outcome: row.outcome,
    decidedBy: row.decidedBy,
    decidedByKind: row.decidedByKind,
    resume: row.resume,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  }));
}
