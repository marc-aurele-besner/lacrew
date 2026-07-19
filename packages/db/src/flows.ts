/** Query helpers for the flows surface (keeps Drizzle inside @lacrew/db). */

import { desc, eq } from "drizzle-orm";
import { flowDefinitions, flowRuns } from "./schema/flows.js";
import type { DbHandle } from "./client.js";

export interface FlowDefinitionRow {
  id: string;
  name: string;
  definition: Record<string, unknown>;
}

export interface FlowRunRow {
  runId: string;
  flowId: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  result: Record<string, unknown>;
}

export async function upsertFlowDefinition(
  handle: DbHandle,
  row: FlowDefinitionRow,
): Promise<void> {
  await handle.db
    .insert(flowDefinitions)
    .values({ id: row.id, name: row.name, definition: row.definition, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: flowDefinitions.id,
      set: { name: row.name, definition: row.definition, updatedAt: new Date() },
    });
}

export async function deleteFlowDefinition(handle: DbHandle, id: string): Promise<void> {
  await handle.db.delete(flowDefinitions).where(eq(flowDefinitions.id, id));
}

export async function listFlowDefinitions(handle: DbHandle): Promise<FlowDefinitionRow[]> {
  const rows = await handle.db
    .select()
    .from(flowDefinitions)
    .orderBy(desc(flowDefinitions.updatedAt));
  return rows.map((row) => ({ id: row.id, name: row.name, definition: row.definition }));
}

export async function insertFlowRun(handle: DbHandle, row: FlowRunRow): Promise<void> {
  await handle.db
    .insert(flowRuns)
    .values({
      runId: row.runId,
      flowId: row.flowId,
      status: row.status,
      startedAt: new Date(row.startedAt),
      finishedAt: new Date(row.finishedAt),
      result: row.result,
    })
    .onConflictDoNothing();
}

/** Most recent runs, newest → oldest. */
export async function recentFlowRuns(handle: DbHandle, limit: number): Promise<FlowRunRow[]> {
  const rows = await handle.db
    .select()
    .from(flowRuns)
    .orderBy(desc(flowRuns.startedAt), desc(flowRuns.id))
    .limit(limit);
  return rows.map((row) => ({
    runId: row.runId,
    flowId: row.flowId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    result: row.result,
  }));
}
