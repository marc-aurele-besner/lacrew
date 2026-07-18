/** Query helpers for the orchestrator audit trail (keeps Drizzle inside @lacrew/db). */

import { desc } from "drizzle-orm";
import { auditEvents } from "./schema/audit.js";
import type { DbHandle } from "./client.js";

export interface AuditEventRow {
  type: string;
  /** ISO timestamp of the event itself. */
  at: string;
  orgId?: string | null;
  payload: Record<string, unknown>;
}

export async function insertAuditEvent(handle: DbHandle, event: AuditEventRow): Promise<void> {
  await handle.db.insert(auditEvents).values({
    type: event.type,
    at: new Date(event.at),
    orgId: event.orgId ?? null,
    payload: event.payload,
  });
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
  }));
}
