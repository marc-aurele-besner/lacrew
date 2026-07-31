/** Query helpers for the flows surface (keeps Drizzle inside @lacrew/db). */

import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { flowCheckpoints, flowDefinitions, flowRunState, flowRuns } from "./schema/flows.js";
import type { DbHandle } from "./client.js";

export interface FlowDefinitionRow {
  id: string;
  name: string;
  definition: Record<string, unknown>;
  /** Null = org-wide. Denormalized from definition.scope for SQL filtering. */
  scopeLevel?: string | null;
  scopeRef?: string | null;
}

export interface FlowRunRow {
  runId: string;
  flowId: string;
  status: string;
  principal?: string | null;
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
    .values({
      id: row.id,
      name: row.name,
      definition: row.definition,
      scopeLevel: row.scopeLevel ?? null,
      scopeRef: row.scopeRef ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: flowDefinitions.id,
      set: {
        name: row.name,
        definition: row.definition,
        scopeLevel: row.scopeLevel ?? null,
        scopeRef: row.scopeRef ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function getFlowDefinition(
  handle: DbHandle,
  id: string,
): Promise<FlowDefinitionRow | null> {
  const rows = await handle.db
    .select()
    .from(flowDefinitions)
    .where(eq(flowDefinitions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    definition: row.definition,
    scopeLevel: row.scopeLevel,
    scopeRef: row.scopeRef,
  };
}

export async function deleteFlowDefinition(handle: DbHandle, id: string): Promise<void> {
  await handle.db.delete(flowDefinitions).where(eq(flowDefinitions.id, id));
}

export async function listFlowDefinitions(handle: DbHandle): Promise<FlowDefinitionRow[]> {
  const rows = await handle.db
    .select()
    .from(flowDefinitions)
    .orderBy(desc(flowDefinitions.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    definition: row.definition,
    scopeLevel: row.scopeLevel,
    scopeRef: row.scopeRef,
  }));
}

/**
 * Record a run, or update it in place.
 *
 * A run id is written more than once now that a run can suspend on an ask-mode
 * connector write (F2.24) and be resumed hours later: first as `waiting`, then
 * again when it finishes. The later write is the same run, further along, so it
 * replaces the row — leaving the first one would report a merge that has since
 * happened as still waiting on a human.
 */
export async function insertFlowRun(handle: DbHandle, row: FlowRunRow): Promise<void> {
  const values = {
    runId: row.runId,
    flowId: row.flowId,
    status: row.status,
    principal: row.principal ?? null,
    startedAt: new Date(row.startedAt),
    finishedAt: new Date(row.finishedAt),
    result: row.result,
  };
  await handle.db
    .insert(flowRuns)
    .values(values)
    .onConflictDoUpdate({
      target: flowRuns.runId,
      set: { status: values.status, finishedAt: values.finishedAt, result: values.result },
    });
}

export interface FlowRunStateRow {
  runId: string;
  flowId: string;
  status: string;
  request?: string | null;
  principal?: string | null;
  trigger?: string | null;
  cursor?: string | null;
  state?: Record<string, unknown> | null;
  pause?: Record<string, unknown> | null;
  attempt?: Record<string, unknown> | null;
  startedAt: string;
  updatedAt: string;
}

export interface FlowCheckpointRow {
  runId: string;
  seq: number;
  flowId: string;
  stepId: string;
  nextStepId?: string | null;
  status: string;
  pause?: Record<string, unknown> | null;
  state?: Record<string, unknown> | null;
  at: string;
}

function toRunState(row: typeof flowRunState.$inferSelect): FlowRunStateRow {
  return {
    runId: row.runId,
    flowId: row.flowId,
    status: row.status,
    request: row.request,
    principal: row.principal,
    trigger: row.trigger,
    cursor: row.cursor,
    state: row.state,
    pause: row.pause,
    attempt: row.attempt,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Announce a run as in flight, or move an existing one along.
 *
 * `request` is deliberately not written here: it belongs to whoever asked for
 * the pause, and a worker checkpointing its own progress must not clear an
 * operator's instruction it has not yet reached.
 */
export async function upsertFlowRunState(
  handle: DbHandle,
  row: Omit<FlowRunStateRow, "updatedAt" | "request">,
): Promise<void> {
  const values = {
    runId: row.runId,
    flowId: row.flowId,
    status: row.status,
    principal: row.principal ?? null,
    trigger: row.trigger ?? null,
    cursor: row.cursor ?? null,
    state: row.state ?? null,
    pause: row.pause ?? null,
    attempt: row.attempt ?? null,
    startedAt: new Date(row.startedAt),
    updatedAt: new Date(),
  };
  await handle.db
    .insert(flowRunState)
    .values(values)
    .onConflictDoUpdate({
      target: flowRunState.runId,
      set: {
        flowId: values.flowId,
        status: values.status,
        principal: values.principal,
        trigger: values.trigger,
        cursor: values.cursor,
        state: values.state,
        pause: values.pause,
        attempt: values.attempt,
        updatedAt: values.updatedAt,
      },
    });
}

/** Set or clear the open attempt without disturbing the rest of the row. */
export async function setFlowRunAttempt(
  handle: DbHandle,
  runId: string,
  attempt: Record<string, unknown> | null,
): Promise<void> {
  await handle.db
    .update(flowRunState)
    .set({ attempt, updatedAt: new Date() })
    .where(eq(flowRunState.runId, runId));
}

/** Record an operator's pause / cancel request, or clear it once honoured. */
export async function setFlowRunRequest(
  handle: DbHandle,
  runId: string,
  request: string | null,
): Promise<void> {
  await handle.db
    .update(flowRunState)
    .set({ request, updatedAt: new Date() })
    .where(eq(flowRunState.runId, runId));
}

export async function getFlowRunState(
  handle: DbHandle,
  runId: string,
): Promise<FlowRunStateRow | null> {
  const rows = await handle.db
    .select()
    .from(flowRunState)
    .where(eq(flowRunState.runId, runId))
    .limit(1);
  const row = rows[0];
  return row ? toRunState(row) : null;
}

/** Every run in one of the given lifecycle states, oldest first. */
export async function listFlowRunStates(
  handle: DbHandle,
  statuses: string[],
): Promise<FlowRunStateRow[]> {
  if (statuses.length === 0) return [];
  const rows = await handle.db
    .select()
    .from(flowRunState)
    .where(inArray(flowRunState.status, statuses))
    .orderBy(flowRunState.startedAt);
  return rows.map(toRunState);
}

/**
 * Write a checkpoint and move the run's cursor in one transaction.
 *
 * Two statements because they answer two different questions — what had
 * happened by then, and where the run is now — but one transaction, because a
 * cursor that advanced past a checkpoint nobody recorded is exactly the state
 * this feature exists to make impossible.
 */
export async function recordFlowCheckpoint(
  handle: DbHandle,
  checkpoint: FlowCheckpointRow,
  run: Omit<FlowRunStateRow, "updatedAt" | "request">,
): Promise<void> {
  await handle.db.transaction(async (tx) => {
    await tx
      .insert(flowCheckpoints)
      .values({
        runId: checkpoint.runId,
        seq: checkpoint.seq,
        flowId: checkpoint.flowId,
        stepId: checkpoint.stepId,
        nextStepId: checkpoint.nextStepId ?? null,
        status: checkpoint.status,
        pause: checkpoint.pause ?? null,
        state: checkpoint.state ?? null,
        at: new Date(checkpoint.at),
      })
      .onConflictDoUpdate({
        target: [flowCheckpoints.runId, flowCheckpoints.seq],
        set: {
          stepId: checkpoint.stepId,
          nextStepId: checkpoint.nextStepId ?? null,
          status: checkpoint.status,
          pause: checkpoint.pause ?? null,
          state: checkpoint.state ?? null,
          at: new Date(checkpoint.at),
        },
      });
    await tx
      .insert(flowRunState)
      .values({
        runId: run.runId,
        flowId: run.flowId,
        status: run.status,
        principal: run.principal ?? null,
        trigger: run.trigger ?? null,
        cursor: run.cursor ?? null,
        state: run.state ?? null,
        pause: run.pause ?? null,
        attempt: run.attempt ?? null,
        startedAt: new Date(run.startedAt),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: flowRunState.runId,
        set: {
          status: run.status,
          cursor: run.cursor ?? null,
          state: run.state ?? null,
          pause: run.pause ?? null,
          attempt: run.attempt ?? null,
          updatedAt: new Date(),
        },
      });
  });
}

/** The checkpoint trail of one run, oldest → newest. */
export async function listFlowCheckpoints(
  handle: DbHandle,
  runId: string,
): Promise<FlowCheckpointRow[]> {
  const rows = await handle.db
    .select()
    .from(flowCheckpoints)
    .where(eq(flowCheckpoints.runId, runId))
    .orderBy(flowCheckpoints.seq);
  return rows.map((row) => ({
    runId: row.runId,
    seq: row.seq,
    flowId: row.flowId,
    stepId: row.stepId,
    nextStepId: row.nextStepId,
    status: row.status,
    pause: row.pause,
    state: row.state,
    at: row.at.toISOString(),
  }));
}

/**
 * Drop the working state of runs that ended before `before`.
 *
 * The finished trace lives in `orchestrator_flow_runs` and is not touched: what
 * goes is the resume payload, which is only useful to a run that could still
 * move. Paused and running rows are never pruned by age here — a run parked on
 * a human is not garbage, and deciding when it has waited too long is a policy
 * question, not a storage one.
 */
export async function pruneFlowRunState(handle: DbHandle, before: Date): Promise<number> {
  const rows = await handle.db
    .delete(flowRunState)
    .where(
      and(
        inArray(flowRunState.status, ["completed", "error", "cancelled", "max_steps"]),
        lt(flowRunState.updatedAt, before),
      ),
    )
    .returning({ runId: flowRunState.runId });
  if (rows.length > 0) {
    await handle.db.delete(flowCheckpoints).where(
      inArray(
        flowCheckpoints.runId,
        rows.map((r) => r.runId),
      ),
    );
  }
  return rows.length;
}

/** Runs that were mid-write when their process died: status running, attempt open. */
export async function listCrashedFlowWrites(handle: DbHandle): Promise<FlowRunStateRow[]> {
  const rows = await handle.db
    .select()
    .from(flowRunState)
    .where(and(eq(flowRunState.status, "running"), isNotNull(flowRunState.attempt)))
    .orderBy(flowRunState.startedAt);
  return rows.map(toRunState);
}

/** One finished run by id; null while it is still in flight. */
export async function getFlowRun(handle: DbHandle, runId: string): Promise<FlowRunRow | null> {
  const rows = await handle.db
    .select()
    .from(flowRuns)
    .where(eq(flowRuns.runId, runId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    runId: row.runId,
    flowId: row.flowId,
    status: row.status,
    principal: row.principal,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    result: row.result,
  };
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
    principal: row.principal,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    result: row.result,
  }));
}
