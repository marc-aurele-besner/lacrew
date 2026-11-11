/** Query helpers for the org directory (keeps Drizzle inside @lacrew/db). */

import { eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { assertValidOrgId, type DbHandle } from "./client.js";
import * as schema from "./schema/index.js";
import { orgs } from "./schema/orgs.js";

export interface OrgRow {
  orgId: string;
  /** `sandbox`, `testnet` or `mainnet`. */
  mode: string;
  chainId: number | null;
  addresses: Record<string, string> | null;
  seats: Record<string, string> | null;
  /** ISO timestamp the org was first registered at. */
  createdAt: string;
}

function toOrg(row: typeof orgs.$inferSelect): OrgRow {
  return {
    orgId: row.orgId,
    mode: row.mode,
    chainId: row.chainId,
    addresses: row.addresses,
    seats: row.seats,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getOrg(handle: DbHandle, orgId: string): Promise<OrgRow | null> {
  const rows = await handle.db.select().from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
  return rows[0] ? toOrg(rows[0]) : null;
}

/** Every registered org, oldest first. */
export async function listOrgs(handle: DbHandle): Promise<OrgRow[]> {
  const rows = await handle.db.select().from(orgs).orderBy(orgs.createdAt, orgs.orgId);
  return rows.map(toOrg);
}

/**
 * Register an org, or change what a registered one is.
 *
 * Only the fields given are written on an existing row, so re-registering an
 * org with its mode alone leaves its addresses and seats as they were. Returns
 * the row as stored and whether this call created it.
 */
export async function upsertOrg(
  handle: DbHandle,
  input: {
    orgId: string;
    mode: string;
    chainId?: number | null;
    addresses?: Record<string, string> | null;
    seats?: Record<string, string> | null;
  },
): Promise<{ org: OrgRow; created: boolean }> {
  const orgId = assertValidOrgId(input.orgId);
  const changes = {
    mode: input.mode,
    ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
    ...(input.addresses === undefined ? {} : { addresses: input.addresses }),
    ...(input.seats === undefined ? {} : { seats: input.seats }),
  };
  const rows = await handle.db
    .insert(orgs)
    .values({ orgId, ...changes })
    .onConflictDoUpdate({ target: orgs.orgId, set: changes })
    // `xmax` is zero only on a row this statement inserted.
    .returning({ ...getTableColumns(orgs), created: sql<boolean>`(xmax = 0)` });
  const { created, ...row } = rows[0]!;
  return { org: toOrg(row), created };
}

/**
 * Remove an org from the directory and delete every row stored under it, in
 * one transaction. Returns whether the org was registered.
 *
 * The tables are walked from the schema rather than listed, so a table added
 * later is cleared here without anybody remembering to add it.
 */
export async function deleteOrg(handle: DbHandle, orgId: string): Promise<boolean> {
  return handle.db.transaction(async (tx) => {
    const removed = await tx
      .delete(orgs)
      .where(eq(orgs.orgId, orgId))
      .returning({ orgId: orgs.orgId });
    for (const table of Object.values(schema as Record<string, unknown>)) {
      if (!(table instanceof PgTable) || getTableName(table) === getTableName(orgs)) continue;
      const columns: PgColumn[] = Object.values(getTableColumns(table));
      const column = columns.find((c) => c.name === "org_id");
      if (!column) continue;
      await tx.delete(table).where(eq(column, orgId));
    }
    return removed.length > 0;
  });
}
