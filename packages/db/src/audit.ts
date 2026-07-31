/** Query helpers for the orchestrator audit trail (keeps Drizzle inside @lacrew/db). */

import { and, count, desc, gte, lt } from "drizzle-orm";
import { auditEvents } from "./schema/audit.js";
import type { DbHandle } from "./client.js";

export interface AuditEventRow {
  type: string;
  /** ISO timestamp of the event itself. */
  at: string;
  orgId?: string | null;
  payload: Record<string, unknown>;
  /** Chain coordinates when sourced from a log. */
  txHash?: string | null;
  logIndex?: number | null;
}

export async function insertAuditEvent(handle: DbHandle, event: AuditEventRow): Promise<void> {
  await handle.db.insert(auditEvents).values({
    type: event.type,
    at: new Date(event.at),
    orgId: event.orgId ?? null,
    payload: event.payload,
    txHash: event.txHash ?? null,
    logIndex: event.logIndex ?? null,
  });
}

/**
 * Idempotent insert for chain-sourced events: rows sharing (tx_hash, log_index)
 * are silently skipped, so re-running a backfill never duplicates.
 */
export async function insertChainAuditEvent(
  handle: DbHandle,
  event: AuditEventRow & { txHash: string; logIndex: number },
): Promise<void> {
  await handle.db
    .insert(auditEvents)
    .values({
      type: event.type,
      at: new Date(event.at),
      orgId: event.orgId ?? null,
      payload: event.payload,
      txHash: event.txHash,
      logIndex: event.logIndex,
    })
    .onConflictDoNothing();
}

/**
 * Event counts by type since `sinceIso` (inclusive) — the read a usage meter
 * is built from. Counting happens over the full persisted trail, so unlike
 * the bounded in-memory ring it is complete for the period.
 */
export async function countAuditEventsByType(
  handle: DbHandle,
  sinceIso: string,
): Promise<Array<{ type: string; count: number }>> {
  const rows = await handle.db
    .select({ type: auditEvents.type, count: count() })
    .from(auditEvents)
    .where(gte(auditEvents.at, new Date(sinceIso)))
    .groupBy(auditEvents.type);
  return rows.map((row) => ({ type: row.type, count: Number(row.count) }));
}

/**
 * Every event in `[fromIso, toIso)`, newest first — the read a period report
 * (F2.33) is folded from.
 *
 * Half-open on purpose: two adjacent periods must not both claim a row that
 * landed exactly on their shared boundary. `limit` is a safety stop, not a
 * page: the caller has to say whether it truncated, because a P&L served from
 * a silently cut window understates a bill.
 */
export async function auditEventsBetween(
  handle: DbHandle,
  fromIso: string,
  toIso: string,
  limit: number,
): Promise<AuditEventRow[]> {
  const rows = await handle.db
    .select()
    .from(auditEvents)
    .where(and(gte(auditEvents.at, new Date(fromIso)), lt(auditEvents.at, new Date(toIso))))
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(limit);
  return rows.map((row) => ({
    type: row.type,
    at: row.at.toISOString(),
    orgId: row.orgId,
    payload: row.payload,
    txHash: row.txHash,
    logIndex: row.logIndex,
  }));
}

/** Most recent events, oldest → newest. */
export async function recentAuditEvents(handle: DbHandle, limit: number): Promise<AuditEventRow[]> {
  const rows = await handle.db
    .select()
    .from(auditEvents)
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(limit);
  return rows.reverse().map((row) => ({
    type: row.type,
    at: row.at.toISOString(),
    orgId: row.orgId,
    payload: row.payload,
    txHash: row.txHash,
    logIndex: row.logIndex,
  }));
}
