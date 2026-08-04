/** Query helpers for crew heartbeats (keeps Drizzle inside @lacrew/db). */

import { and, desc, eq, lt } from "drizzle-orm";
import { crewHeartbeats, crewHeartbeatTicks } from "./schema/heartbeat.js";
import type { DbHandle } from "./client.js";

export interface CrewHeartbeatRow {
  crewId: string;
  schedule: string;
  timezone?: string | null;
  quietHours?: Record<string, unknown> | null;
  checklist: unknown[];
  principal?: string | null;
  model?: string | null;
  notifyOnOk: boolean;
  stopOnError: boolean;
  enabled: boolean;
  updatedAt: string;
}

export interface CrewHeartbeatTickRow {
  crewId: string;
  windowKey: string;
  status: string;
  items?: unknown[] | null;
  messageId?: string | null;
  /** Metered model spend for this tick's runs; null when nothing metered it. */
  usage?: Record<string, unknown> | null;
  startedAt: string;
  finishedAt?: string | null;
}

/** Tick rows older than this are pruned; the ledger is not an archive. */
const TICK_RETENTION_DAYS = 30;

function rowToHeartbeat(row: typeof crewHeartbeats.$inferSelect): CrewHeartbeatRow {
  return {
    crewId: row.crewId,
    schedule: row.schedule,
    timezone: row.timezone,
    quietHours: row.quietHours,
    checklist: row.checklist ?? [],
    principal: row.principal,
    model: row.model,
    notifyOnOk: row.notifyOnOk,
    stopOnError: row.stopOnError,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function upsertCrewHeartbeat(handle: DbHandle, row: CrewHeartbeatRow): Promise<void> {
  const values = {
    crewId: row.crewId,
    schedule: row.schedule,
    timezone: row.timezone ?? null,
    quietHours: row.quietHours ?? null,
    checklist: row.checklist,
    principal: row.principal ?? null,
    model: row.model ?? null,
    notifyOnOk: row.notifyOnOk,
    stopOnError: row.stopOnError,
    enabled: row.enabled,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(crewHeartbeats)
    .values(values)
    .onConflictDoUpdate({ target: crewHeartbeats.crewId, set: values });
}

export async function deleteCrewHeartbeat(handle: DbHandle, crewId: string): Promise<void> {
  await handle.db.delete(crewHeartbeats).where(eq(crewHeartbeats.crewId, crewId));
}

export async function listCrewHeartbeats(handle: DbHandle): Promise<CrewHeartbeatRow[]> {
  const rows = await handle.db.select().from(crewHeartbeats);
  return rows.map(rowToHeartbeat);
}

export async function getCrewHeartbeat(
  handle: DbHandle,
  crewId: string,
): Promise<CrewHeartbeatRow | null> {
  const rows = await handle.db
    .select()
    .from(crewHeartbeats)
    .where(eq(crewHeartbeats.crewId, crewId))
    .limit(1);
  const row = rows[0];
  return row ? rowToHeartbeat(row) : null;
}

/**
 * Take the tick for one firing window. True when this caller got it.
 *
 * The insert *is* the claim: a duplicate dispatch — a redelivered sweep, a
 * second replica — conflicts on `(crew_id, window_key)` and gets false, which
 * is what keeps a crew's checklist from being worked through twice at once.
 */
export async function claimCrewHeartbeatTick(
  handle: DbHandle,
  row: { crewId: string; windowKey: string },
): Promise<boolean> {
  const inserted = await handle.db
    .insert(crewHeartbeatTicks)
    .values({
      crewId: row.crewId,
      windowKey: row.windowKey,
      status: "running",
      startedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ windowKey: crewHeartbeatTicks.windowKey });
  return inserted.length > 0;
}

/** Attach the outcome to an already-claimed tick. */
export async function settleCrewHeartbeatTick(
  handle: DbHandle,
  row: {
    crewId: string;
    windowKey: string;
    status: string;
    items?: unknown[] | null;
    messageId?: string | null;
    usage?: Record<string, unknown> | null;
  },
): Promise<void> {
  await handle.db
    .update(crewHeartbeatTicks)
    .set({
      status: row.status,
      items: row.items ?? null,
      messageId: row.messageId ?? null,
      usage: row.usage ?? null,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(crewHeartbeatTicks.crewId, row.crewId),
        eq(crewHeartbeatTicks.windowKey, row.windowKey),
      ),
    );
}

export async function recentCrewHeartbeatTicks(
  handle: DbHandle,
  limit: number,
  crewId?: string,
): Promise<CrewHeartbeatTickRow[]> {
  const base = handle.db.select().from(crewHeartbeatTicks);
  const rows = await (crewId ? base.where(eq(crewHeartbeatTicks.crewId, crewId)) : base)
    .orderBy(desc(crewHeartbeatTicks.startedAt))
    .limit(limit);
  return rows.map((row) => ({
    crewId: row.crewId,
    windowKey: row.windowKey,
    status: row.status,
    items: row.items,
    messageId: row.messageId,
    usage: row.usage,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  }));
}

export async function pruneCrewHeartbeatTicks(
  handle: DbHandle,
  days = TICK_RETENTION_DAYS,
): Promise<void> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await handle.db.delete(crewHeartbeatTicks).where(lt(crewHeartbeatTicks.startedAt, cutoff));
}
