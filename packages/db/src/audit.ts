/** Query helpers for the orchestrator audit trail (keeps Drizzle inside @lacrew/db). */

import { and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { auditEvents } from "./schema/audit.js";
import type { DbHandle } from "./client.js";

export interface AuditEventRow {
  type: string;
  /** ISO timestamp of the event itself. */
  at: string;
  orgId?: string | null;
  payload: Record<string, unknown>;
  /** EIP-155 chain id; null only for rows with no chain at all. */
  chainId?: number | null;
  /** Chain coordinates when sourced from a log. */
  txHash?: string | null;
  logIndex?: number | null;
}

/**
 * Optional chain scope for reads. When `chainId` is set only that chain's
 * rows answer; when absent the read spans every chain — a caller serving a
 * per-deployment surface (usage meter, activity feed) should scope, because
 * a testnet row folded into a mainnet report is a wrong number, not noise.
 */
export interface AuditReadOptions {
  chainId?: number;
}

function chainScope(options?: AuditReadOptions): SQL | undefined {
  return options?.chainId === undefined ? undefined : eq(auditEvents.chainId, options.chainId);
}

export async function insertAuditEvent(handle: DbHandle, event: AuditEventRow): Promise<void> {
  await handle.db.insert(auditEvents).values({
    type: event.type,
    at: new Date(event.at),
    orgId: event.orgId ?? null,
    payload: event.payload,
    chainId: event.chainId ?? null,
    txHash: event.txHash ?? null,
    logIndex: event.logIndex ?? null,
  });
}

/**
 * Idempotent insert for chain-sourced events: rows sharing
 * (chain_id, tx_hash, log_index) are silently skipped, so re-running a
 * backfill never duplicates — and the chain id is part of the identity, so
 * two chains that happen to reuse a (tx_hash, log_index) pair (EIP-155 makes
 * that rare, not impossible) both keep their row.
 */
export async function insertChainAuditEvent(
  handle: DbHandle,
  event: AuditEventRow & { chainId: number; txHash: string; logIndex: number },
): Promise<void> {
  await handle.db
    .insert(auditEvents)
    .values({
      type: event.type,
      at: new Date(event.at),
      orgId: event.orgId ?? null,
      payload: event.payload,
      chainId: event.chainId,
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
  options?: AuditReadOptions,
): Promise<Array<{ type: string; count: number }>> {
  const rows = await handle.db
    .select({ type: auditEvents.type, count: count() })
    .from(auditEvents)
    .where(and(gte(auditEvents.at, new Date(sinceIso)), chainScope(options)))
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
  options?: AuditReadOptions,
): Promise<AuditEventRow[]> {
  const rows = await handle.db
    .select()
    .from(auditEvents)
    .where(
      and(
        gte(auditEvents.at, new Date(fromIso)),
        lt(auditEvents.at, new Date(toIso)),
        chainScope(options),
      ),
    )
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(limit);
  return rows.map((row) => ({
    type: row.type,
    at: row.at.toISOString(),
    orgId: row.orgId,
    payload: row.payload,
    chainId: row.chainId,
    txHash: row.txHash,
    logIndex: row.logIndex,
  }));
}

/** Most recent events, oldest → newest. */
export async function recentAuditEvents(
  handle: DbHandle,
  limit: number,
  options?: AuditReadOptions,
): Promise<AuditEventRow[]> {
  const rows = await handle.db
    .select()
    .from(auditEvents)
    .where(chainScope(options))
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(limit);
  return rows.reverse().map((row) => ({
    type: row.type,
    at: row.at.toISOString(),
    orgId: row.orgId,
    payload: row.payload,
    chainId: row.chainId,
    txHash: row.txHash,
    logIndex: row.logIndex,
  }));
}
