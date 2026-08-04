/** Query helpers for inference budgets (keeps Drizzle inside @lacrew/db). */

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { inferenceBudgets, inferenceUsage, inferenceUsageEvents } from "./schema/budgets.js";
import type { DbHandle } from "./client.js";

export interface InferenceBudgetRow {
  scopeKey: string;
  crewId: string;
  agentId?: string | null;
  period: string;
  windowDays?: number | null;
  epochSeconds?: number | null;
  anchorAt?: string | null;
  limits: Record<string, unknown>;
  policy: string;
  cheapModel?: string | null;
  pauseHeartbeatOnBreach: boolean;
  enabled: boolean;
  updatedAt: string;
}

export interface InferenceUsageRow {
  scopeKey: string;
  periodKey: string;
  inputTokens: number;
  outputTokens: number;
  usdMicros: number;
  calls: number;
  unpricedCalls: number;
  alertedState: string;
  updatedAt: string;
}

export interface InferenceUsageEventRow {
  scopeKey: string;
  periodKey: string;
  model: string;
  provider?: string | null;
  inputTokens: number;
  outputTokens: number;
  usdMicros?: number | null;
  priceSource: string;
  tokensEstimated: boolean;
  runId?: string | null;
  flowId?: string | null;
  at: string;
}

/** Event rows older than this are pruned; the enforced counter is elsewhere. */
const EVENT_RETENTION_DAYS = 60;

function rowToBudget(row: typeof inferenceBudgets.$inferSelect): InferenceBudgetRow {
  return {
    scopeKey: row.scopeKey,
    crewId: row.crewId,
    agentId: row.agentId,
    period: row.period,
    windowDays: row.windowDays,
    epochSeconds: row.epochSeconds,
    anchorAt: row.anchorAt ? row.anchorAt.toISOString() : null,
    limits: row.limits ?? {},
    policy: row.policy,
    cheapModel: row.cheapModel,
    pauseHeartbeatOnBreach: row.pauseHeartbeatOnBreach,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function upsertInferenceBudget(
  handle: DbHandle,
  row: InferenceBudgetRow,
): Promise<void> {
  const values = {
    scopeKey: row.scopeKey,
    crewId: row.crewId,
    agentId: row.agentId ?? null,
    period: row.period,
    windowDays: row.windowDays ?? null,
    epochSeconds: row.epochSeconds ?? null,
    anchorAt: row.anchorAt ? new Date(row.anchorAt) : null,
    limits: row.limits,
    policy: row.policy,
    cheapModel: row.cheapModel ?? null,
    pauseHeartbeatOnBreach: row.pauseHeartbeatOnBreach,
    enabled: row.enabled,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(inferenceBudgets)
    .values(values)
    .onConflictDoUpdate({ target: inferenceBudgets.scopeKey, set: values });
}

export async function deleteInferenceBudget(handle: DbHandle, scopeKey: string): Promise<void> {
  await handle.db.delete(inferenceBudgets).where(eq(inferenceBudgets.scopeKey, scopeKey));
}

export async function listInferenceBudgets(handle: DbHandle): Promise<InferenceBudgetRow[]> {
  const rows = await handle.db.select().from(inferenceBudgets);
  return rows.map(rowToBudget);
}

export async function getInferenceBudget(
  handle: DbHandle,
  scopeKey: string,
): Promise<InferenceBudgetRow | null> {
  const rows = await handle.db
    .select()
    .from(inferenceBudgets)
    .where(eq(inferenceBudgets.scopeKey, scopeKey))
    .limit(1);
  const row = rows[0];
  return row ? rowToBudget(row) : null;
}

/**
 * Add one call to a period's counters and return the row as it now stands.
 *
 * The increments are SQL expressions rather than a read, an add and a write:
 * two replicas metering the same crew at the same instant would otherwise each
 * read the same total and each write it back plus their own call, losing one.
 * The returned row is what the caller compares against the limit, so the
 * decision is made on a number no other writer can have replaced in between.
 */
export async function addInferenceUsage(
  handle: DbHandle,
  row: {
    scopeKey: string;
    periodKey: string;
    inputTokens: number;
    outputTokens: number;
    usdMicros: number;
    unpriced: boolean;
  },
): Promise<InferenceUsageRow> {
  const unpriced = row.unpriced ? 1 : 0;
  const [updated] = await handle.db
    .insert(inferenceUsage)
    .values({
      scopeKey: row.scopeKey,
      periodKey: row.periodKey,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      usdMicros: row.usdMicros,
      calls: 1,
      unpricedCalls: unpriced,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [inferenceUsage.scopeKey, inferenceUsage.periodKey],
      set: {
        inputTokens: sql`${inferenceUsage.inputTokens} + ${row.inputTokens}`,
        outputTokens: sql`${inferenceUsage.outputTokens} + ${row.outputTokens}`,
        usdMicros: sql`${inferenceUsage.usdMicros} + ${row.usdMicros}`,
        calls: sql`${inferenceUsage.calls} + 1`,
        unpricedCalls: sql`${inferenceUsage.unpricedCalls} + ${unpriced}`,
        updatedAt: new Date(),
      },
    })
    .returning();
  // An upsert that returned nothing means the counter was not written, and a
  // guard that decided on a stale total is worse than one that errors: the
  // caller fails the call closed rather than admitting an unmetered one.
  if (!updated) throw new Error("inference_usage_write_failed");
  return usageFromRow(updated);
}

function usageFromRow(row: typeof inferenceUsage.$inferSelect): InferenceUsageRow {
  return {
    scopeKey: row.scopeKey,
    periodKey: row.periodKey,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    usdMicros: row.usdMicros,
    calls: row.calls,
    unpricedCalls: row.unpricedCalls,
    alertedState: row.alertedState,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getInferenceUsage(
  handle: DbHandle,
  scopeKey: string,
  periodKey: string,
): Promise<InferenceUsageRow | null> {
  const rows = await handle.db
    .select()
    .from(inferenceUsage)
    .where(and(eq(inferenceUsage.scopeKey, scopeKey), eq(inferenceUsage.periodKey, periodKey)))
    .limit(1);
  const row = rows[0];
  return row ? usageFromRow(row) : null;
}

/**
 * Move the announced alert state forward, and say whether this caller was the
 * one that moved it. Only the winner sends the alert, so a crew crossing 80%
 * under two replicas notifies its humans once.
 */
export async function claimInferenceAlert(
  handle: DbHandle,
  row: { scopeKey: string; periodKey: string; from: string; to: string },
): Promise<boolean> {
  const updated = await handle.db
    .update(inferenceUsage)
    .set({ alertedState: row.to })
    .where(
      and(
        eq(inferenceUsage.scopeKey, row.scopeKey),
        eq(inferenceUsage.periodKey, row.periodKey),
        eq(inferenceUsage.alertedState, row.from),
      ),
    )
    .returning({ scopeKey: inferenceUsage.scopeKey });
  return updated.length > 0;
}

export async function insertInferenceUsageEvent(
  handle: DbHandle,
  row: InferenceUsageEventRow,
): Promise<void> {
  await handle.db.insert(inferenceUsageEvents).values({
    scopeKey: row.scopeKey,
    periodKey: row.periodKey,
    model: row.model,
    provider: row.provider ?? null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    usdMicros: row.usdMicros ?? null,
    priceSource: row.priceSource,
    tokensEstimated: row.tokensEstimated,
    runId: row.runId ?? null,
    flowId: row.flowId ?? null,
    at: new Date(row.at),
  });
}

export async function recentInferenceUsageEvents(
  handle: DbHandle,
  limit: number,
  scopeKey?: string,
  periodKey?: string,
): Promise<InferenceUsageEventRow[]> {
  const filters = [
    ...(scopeKey ? [eq(inferenceUsageEvents.scopeKey, scopeKey)] : []),
    ...(periodKey ? [eq(inferenceUsageEvents.periodKey, periodKey)] : []),
  ];
  const base = handle.db.select().from(inferenceUsageEvents);
  const rows = await (filters.length ? base.where(and(...filters)) : base)
    .orderBy(desc(inferenceUsageEvents.at))
    .limit(limit);
  return rows.map((row) => ({
    scopeKey: row.scopeKey,
    periodKey: row.periodKey,
    model: row.model,
    provider: row.provider,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    usdMicros: row.usdMicros,
    priceSource: row.priceSource,
    tokensEstimated: row.tokensEstimated,
    runId: row.runId,
    flowId: row.flowId,
    at: row.at.toISOString(),
  }));
}

/**
 * Metered calls in `[fromIso, toIso)` for a set of scope keys — the inference
 * half of a period report (F2.33).
 *
 * Scope keys are passed explicitly rather than matched by prefix: `crew:<id>`
 * and `crew:<id>/agent:<0x…>` both hold a row for the same seat call, so a
 * prefix read would count every attributed call twice. The caller names the
 * keys it intends to fold, and folds each one separately.
 */
export async function inferenceUsageEventsBetween(
  handle: DbHandle,
  scopeKeys: readonly string[],
  fromIso: string,
  toIso: string,
  limit: number,
): Promise<InferenceUsageEventRow[]> {
  if (scopeKeys.length === 0) return [];
  const rows = await handle.db
    .select()
    .from(inferenceUsageEvents)
    .where(
      and(
        inArray(inferenceUsageEvents.scopeKey, [...scopeKeys]),
        gte(inferenceUsageEvents.at, new Date(fromIso)),
        lt(inferenceUsageEvents.at, new Date(toIso)),
      ),
    )
    .orderBy(desc(inferenceUsageEvents.at))
    .limit(limit);
  return rows.map((row) => ({
    scopeKey: row.scopeKey,
    periodKey: row.periodKey,
    model: row.model,
    provider: row.provider,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    usdMicros: row.usdMicros,
    priceSource: row.priceSource,
    tokensEstimated: row.tokensEstimated,
    runId: row.runId,
    flowId: row.flowId,
    at: row.at.toISOString(),
  }));
}

export async function pruneInferenceUsageEvents(
  handle: DbHandle,
  days = EVENT_RETENTION_DAYS,
): Promise<void> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await handle.db.delete(inferenceUsageEvents).where(lt(inferenceUsageEvents.at, cutoff));
}
