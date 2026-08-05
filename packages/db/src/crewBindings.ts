/** Query helpers for persisted crew seat bindings (keeps Drizzle inside @lacrew/db). */

import { eq } from "drizzle-orm";
import { crewBindings } from "./schema/crewBindings.js";
import type { DbHandle } from "./client.js";

export interface CrewBindingRow {
  key: string;
  scopeKey: string;
  roleId: string;
  account: string;
  label: string | null;
  blueprintId: string | null;
  crewId: string | null;
  updatedAt: string;
}

export async function upsertCrewBinding(handle: DbHandle, row: CrewBindingRow): Promise<void> {
  const values = {
    key: row.key,
    scopeKey: row.scopeKey,
    roleId: row.roleId,
    account: row.account,
    label: row.label,
    blueprintId: row.blueprintId,
    crewId: row.crewId,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(crewBindings)
    .values(values)
    .onConflictDoUpdate({ target: crewBindings.key, set: values });
}

export async function deleteCrewBinding(handle: DbHandle, key: string): Promise<void> {
  await handle.db.delete(crewBindings).where(eq(crewBindings.key, key));
}

/**
 * Every binding. Unbounded like the plan requirements: there is one row per
 * seat a blueprint install landed, and a trimmed row is a seat the checklist
 * silently stops finding after a rename.
 */
export async function listCrewBindings(handle: DbHandle): Promise<CrewBindingRow[]> {
  const rows = await handle.db.select().from(crewBindings);
  return rows.map((row) => ({
    key: row.key,
    scopeKey: row.scopeKey,
    roleId: row.roleId,
    account: row.account,
    label: row.label,
    blueprintId: row.blueprintId,
    crewId: row.crewId,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
