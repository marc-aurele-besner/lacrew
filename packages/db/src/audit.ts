/** Query helpers for the orchestrator audit trail (keeps Drizzle inside @lacrew/db). */

import { and, count, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { auditEvents } from "./schema/audit.js";
import { DEFAULT_ORG_ID, type DbHandle } from "./client.js";

export interface AuditEventRow {
  type: string;
  /** ISO timestamp of the event itself. */
  at: string;
  /** The org the event belongs to; `default` when absent. */
  orgId?: string | null;
  payload: Record<string, unknown>;
  /** EIP-155 chain id; null only for rows with no chain at all. */
  chainId?: number | null;
  /** Chain coordinates when sourced from a log. */
  txHash?: string | null;
  logIndex?: number | null;
  /** `chain` when absent. A `sandbox` row is a simulated event; nothing was mined. */
  ledger?: AuditLedger | null;
}

/** Which ledger an audit row belongs to. */
export type AuditLedger = "chain" | "sandbox";

/**
 * Optional chain scope for reads. When `chainId` is set only that chain's
 * rows answer; when absent the read spans every chain — a caller serving a
 * per-deployment surface (usage meter, activity feed) should scope, because
 * a testnet row folded into a mainnet report is a wrong number, not noise.
 */
export interface AuditReadOptions {
  chainId?: number;
  /**
   * Only this org's rows answer. One database can hold many orgs, so a caller
   * serving one org must pass it: without it the read spans every org.
   */
  orgId?: string;
  /**
   * Only this ledger's rows answer. A usage meter must pass `chain`: sandbox
   * rows are simulated activity and billing them would charge for nothing.
   */
  ledger?: AuditLedger;
}

function chainScope(options?: AuditReadOptions): SQL | undefined {
  return and(
    options?.orgId === undefined ? undefined : eq(auditEvents.orgId, options.orgId),
    options?.chainId === undefined ? undefined : eq(auditEvents.chainId, options.chainId),
    options?.ledger === undefined ? undefined : eq(auditEvents.ledger, options.ledger),
  );
}

export async function insertAuditEvent(handle: DbHandle, event: AuditEventRow): Promise<void> {
  await handle.db.insert(auditEvents).values({
    type: event.type,
    at: new Date(event.at),
    orgId: event.orgId ?? DEFAULT_ORG_ID,
    payload: event.payload,
    chainId: event.chainId ?? null,
    txHash: event.txHash ?? null,
    logIndex: event.logIndex ?? null,
    ledger: event.ledger ?? "chain",
  });
}

/**
 * Delete every simulated row of one org. A sandbox reset rebuilds the simulator from
 * genesis, so the trail of the simulation it replaces goes with it. Chain rows
 * are never touched, and neither is any other org's simulation: the predicate
 * is the org and the ledger column, not a time window.
 */
export async function deleteSandboxAuditEvents(handle: DbHandle, orgId: string): Promise<void> {
  await handle.db
    .delete(auditEvents)
    .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.ledger, "sandbox")));
}

/**
 * Idempotent insert for chain-sourced events: rows sharing
 * (org_id, chain_id, tx_hash, log_index) are silently skipped, so re-running a
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
      orgId: event.orgId ?? DEFAULT_ORG_ID,
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
 * Event counts by UTC day × type over `[fromIso, toIso)` — the read a usage
 * chart is drawn from. Only days that hold at least one event come back; the
 * caller fills the quiet ones.
 *
 * The day is cut in UTC whatever the session time zone is, so two servers in
 * different zones bucket the same row into the same day. Half-open for the
 * reason `auditEventsBetween` is: adjacent windows must not both count a row
 * on their shared boundary.
 */
export async function countAuditEventsByDay(
  handle: DbHandle,
  fromIso: string,
  toIso: string,
  options?: AuditReadOptions,
): Promise<Array<{ day: string; type: string; count: number }>> {
  const day = sql<string>`to_char(${auditEvents.at} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await handle.db
    .select({ day, type: auditEvents.type, count: count() })
    .from(auditEvents)
    .where(
      and(
        gte(auditEvents.at, new Date(fromIso)),
        lt(auditEvents.at, new Date(toIso)),
        chainScope(options),
      ),
    )
    .groupBy(day, auditEvents.type)
    .orderBy(day, auditEvents.type);
  return rows.map((row) => ({ day: row.day, type: row.type, count: Number(row.count) }));
}

/**
 * Event counts by agent × type over `[fromIso, toIso)`.
 *
 * The agent is the payload's `agent` string, lower-cased so one address in two
 * checksum casings is one agent. A row whose payload carries no string `agent`
 * answers under `null` rather than being dropped, so the per-agent rows still
 * sum to the window's total.
 */
export async function countAuditEventsByAgent(
  handle: DbHandle,
  fromIso: string,
  toIso: string,
  options?: AuditReadOptions,
): Promise<Array<{ agent: string | null; type: string; count: number }>> {
  const agent = sql<
    string | null
  >`case when jsonb_typeof(${auditEvents.payload} -> 'agent') = 'string' then lower(${auditEvents.payload} ->> 'agent') end`;
  const rows = await handle.db
    .select({ agent, type: auditEvents.type, count: count() })
    .from(auditEvents)
    .where(
      and(
        gte(auditEvents.at, new Date(fromIso)),
        lt(auditEvents.at, new Date(toIso)),
        chainScope(options),
      ),
    )
    .groupBy(agent, auditEvents.type)
    .orderBy(agent, auditEvents.type);
  return rows.map((row) => ({ agent: row.agent, type: row.type, count: Number(row.count) }));
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
    ledger: row.ledger as AuditLedger,
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
    ledger: row.ledger as AuditLedger,
  }));
}
