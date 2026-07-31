/** Query helpers for plan-required mode (keeps Drizzle inside @lacrew/db). */

import { eq } from "drizzle-orm";
import { planRequirements } from "./schema/planRequired.js";
import type { DbHandle } from "./client.js";

export interface PlanRequirementRow {
  scopeKey: string;
  scope: Record<string, unknown>;
  mode: string;
  windowMs: number;
  minPlanChars: number;
  acceptUpstreamPlan: boolean;
  updatedAt: string;
}

export async function upsertPlanRequirement(
  handle: DbHandle,
  row: PlanRequirementRow,
): Promise<void> {
  const values = {
    scopeKey: row.scopeKey,
    scope: row.scope,
    mode: row.mode,
    windowMs: row.windowMs,
    minPlanChars: row.minPlanChars,
    acceptUpstreamPlan: row.acceptUpstreamPlan,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(planRequirements)
    .values(values)
    .onConflictDoUpdate({ target: planRequirements.scopeKey, set: values });
}

export async function deletePlanRequirement(handle: DbHandle, scopeKey: string): Promise<void> {
  await handle.db.delete(planRequirements).where(eq(planRequirements.scopeKey, scopeKey));
}

/**
 * Every requirement. Unbounded like the connector modes: there is one row per
 * scope an operator configured, and a trimmed row is a crew that silently stops
 * being asked to plan.
 */
export async function listPlanRequirements(handle: DbHandle): Promise<PlanRequirementRow[]> {
  const rows = await handle.db.select().from(planRequirements);
  return rows.map((row) => ({
    scopeKey: row.scopeKey,
    scope: row.scope ?? {},
    mode: row.mode,
    windowMs: row.windowMs,
    minPlanChars: row.minPlanChars,
    acceptUpstreamPlan: row.acceptUpstreamPlan,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
