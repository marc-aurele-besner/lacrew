/** Query helpers for the sandbox simulator's persisted state (keeps Drizzle inside @lacrew/db). */

import { and, eq } from "drizzle-orm";
import { sandboxState } from "./schema/sandbox.js";
import type { DbHandle } from "./client.js";

export interface SandboxStateRow {
  orgId: string;
  /** How many writes produced this row; the optimistic lock. */
  version: number;
  /** The simulator's serialised state, opaque to this package. */
  state: unknown;
  /** Seconds the sandbox clock runs ahead of wall time. */
  clockOffset: number;
}

export async function loadSandboxState(
  handle: DbHandle,
  orgId: string,
): Promise<SandboxStateRow | null> {
  const rows = await handle.db
    .select()
    .from(sandboxState)
    .where(eq(sandboxState.orgId, orgId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    orgId: row.orgId,
    version: row.version,
    state: row.state,
    clockOffset: Number(row.clockOffset),
  };
}

/**
 * Write `row` only if the stored version is still `expectedVersion`.
 *
 * `expectedVersion` 0 means "no row yet": the write is an insert, and loses to
 * any row that appeared in the meantime. Returns whether the write landed, so
 * a caller that lost the race reloads and never overwrites newer state.
 */
export async function saveSandboxState(
  handle: DbHandle,
  row: SandboxStateRow,
  expectedVersion: number,
): Promise<boolean> {
  if (expectedVersion === 0) {
    const inserted = await handle.db
      .insert(sandboxState)
      .values({
        orgId: row.orgId,
        version: row.version,
        state: row.state,
        clockOffset: row.clockOffset,
      })
      .onConflictDoNothing()
      .returning({ orgId: sandboxState.orgId });
    return inserted.length > 0;
  }
  const updated = await handle.db
    .update(sandboxState)
    .set({
      version: row.version,
      state: row.state,
      clockOffset: row.clockOffset,
      updatedAt: new Date(),
    })
    .where(and(eq(sandboxState.orgId, row.orgId), eq(sandboxState.version, expectedVersion)))
    .returning({ orgId: sandboxState.orgId });
  return updated.length > 0;
}
