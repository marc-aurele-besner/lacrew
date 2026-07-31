/**
 * FlowStore: pluggable persistence for flow definitions, run traces, and the
 * durable run state a pause / resume rides on (F2.26). Postgres (Drizzle via
 * @lacrew/db) when DATABASE_URL is set, else memory — same provider pattern as
 * AuditStore / QueueProvider / ModelProvider.
 */

import {
  createDb,
  deleteFlowDefinition,
  getDatabaseUrl,
  getFlowDefinition,
  getFlowRun,
  getFlowRunState,
  insertFlowRun,
  listFlowCheckpoints,
  listFlowDefinitions,
  listFlowRunStates,
  recentFlowRuns,
  recordFlowCheckpoint,
  setFlowRunAttempt,
  setFlowRunRequest,
  upsertFlowDefinition,
  upsertFlowRunState,
  type DbHandle,
} from "@lacrew/db";
import type {
  FlowAttempt,
  FlowCheckpoint,
  FlowDefinition,
  FlowResumeState,
  FlowRunResult,
  FlowRunStatus,
  FlowWaiting,
} from "@lacrew/flows";

/** What an operator asked for while the run was moving; cleared once honoured. */
export type FlowRunRequest = "pause" | "cancel";

/** Lifecycle state, one per run. `running` is the only non-`FlowRunStatus` value. */
export type FlowRunLifecycle = "running" | FlowRunStatus;

/**
 * Where a run is, as opposed to what it produced.
 *
 * The trace in `recentRuns` is written when a run ends; this exists while it is
 * still going, which is what makes a run recoverable after the process holding
 * it dies.
 */
export type FlowRunState = {
  runId: string;
  flowId: string;
  status: FlowRunLifecycle;
  request?: FlowRunRequest | null;
  principal?: string | null;
  trigger?: string | null;
  /** Step a resume enters; null when the run went no further. */
  cursor?: string | null;
  state?: FlowResumeState | null;
  pause?: FlowWaiting | null;
  /** Non-null only while a side-effecting step is in flight. */
  attempt?: FlowAttempt | null;
  startedAt: string;
  updatedAt: string;
};

export interface FlowStore {
  readonly name: string;
  /** Persist a definition; must never throw into the caller's flow. */
  save(def: FlowDefinition): Promise<void>;
  remove(id: string): Promise<void>;
  /** All persisted definitions (hydrated into the surface on boot). */
  list(): Promise<FlowDefinition[]>;
  /**
   * One definition by id, read through rather than served from the boot-time
   * map. Replicas share a queue but not memory, so a flow saved after a worker
   * booted is invisible to it — which a webhook delivery discovers as
   * `flow_not_found` on a flow that plainly exists.
   */
  get(id: string): Promise<FlowDefinition | null>;
  appendRun(run: FlowRunResult): Promise<void>;
  /** Most recent runs, newest → oldest. */
  recentRuns(limit: number): Promise<FlowRunResult[]>;
  /** One finished run's trace; null while it is still in flight. */
  getRun(runId: string): Promise<FlowRunResult | null>;

  /** Announce a run as in flight, before its first step. */
  startRun(run: {
    runId: string;
    flowId: string;
    principal?: string;
    trigger?: string;
    startedAt: string;
  }): Promise<void>;
  /**
   * Persist one completed step. Unlike everything above, this throws on
   * failure: a run that moved past a checkpoint nobody wrote is precisely the
   * state pause / resume exists to prevent, so the engine has to hear about it.
   */
  checkpoint(checkpoint: FlowCheckpoint): Promise<void>;
  /** Open (or close, with null) the attempt on a side-effecting step. Throws. */
  setAttempt(runId: string, attempt: FlowAttempt | null): Promise<void>;
  /** Record an operator's pause / cancel request, or clear it once honoured. */
  request(runId: string, request: FlowRunRequest | null): Promise<void>;
  runState(runId: string): Promise<FlowRunState | null>;
  /** Every run in one of the given lifecycle states, oldest first. */
  listRunStates(statuses: FlowRunLifecycle[]): Promise<FlowRunState[]>;
  /** The checkpoint trail of one run, oldest → newest. */
  checkpointsOf(runId: string): Promise<FlowCheckpoint[]>;
  close(): Promise<void>;
}

/**
 * Memory store for mock demos and tests.
 *
 * Definitions and run history stay no-ops — the surface keeps its own map and
 * ring, and neither would survive the restart that makes persistence
 * interesting. Run state is *not* a no-op: pause, resume and cancel read it
 * back within the same process, and a store that dropped it would leave those
 * three silently broken everywhere DATABASE_URL is unset.
 */
export function createMemoryFlowStore(): FlowStore {
  const states = new Map<string, FlowRunState>();
  const checkpoints = new Map<string, FlowCheckpoint[]>();
  const clone = <T>(value: T): T => structuredClone(value);

  return {
    name: "memory",
    save: async () => {},
    remove: async () => {},
    list: async () => [],
    get: async () => null,
    appendRun: async (run) => {
      const existing = states.get(run.runId);
      if (!existing) return;
      states.set(run.runId, {
        ...existing,
        status: run.status,
        cursor: run.resume?.stepId ?? null,
        state: run.resume ? clone(run.resume) : null,
        pause: run.waiting ? clone(run.waiting) : null,
        updatedAt: run.finishedAt,
      });
    },
    recentRuns: async () => [],
    getRun: async () => null,
    startRun: async (run) => {
      const existing = states.get(run.runId);
      states.set(run.runId, {
        ...(existing ?? {}),
        runId: run.runId,
        flowId: run.flowId,
        status: "running",
        principal: run.principal ?? existing?.principal ?? null,
        trigger: run.trigger ?? existing?.trigger ?? null,
        // A resume clears the request it is honouring, not one raised since.
        request: existing?.request ?? null,
        attempt: null,
        startedAt: existing?.startedAt ?? run.startedAt,
        updatedAt: new Date().toISOString(),
      });
    },
    checkpoint: async (cp) => {
      const trail = checkpoints.get(cp.runId) ?? [];
      const at = trail.findIndex((c) => c.seq === cp.seq);
      if (at >= 0) trail.splice(at, 1, clone(cp));
      else trail.push(clone(cp));
      checkpoints.set(cp.runId, trail);
      const existing = states.get(cp.runId);
      states.set(cp.runId, {
        runId: cp.runId,
        flowId: cp.flowId,
        principal: existing?.principal ?? null,
        trigger: existing?.trigger ?? null,
        request: existing?.request ?? null,
        startedAt: existing?.startedAt ?? cp.at,
        status: cp.status === "paused" ? "waiting" : "running",
        cursor: cp.nextStepId,
        state: cp.state ? clone(cp.state) : null,
        pause: cp.pause ? clone(cp.pause) : null,
        attempt: null,
        updatedAt: cp.at,
      });
    },
    setAttempt: async (runId, attempt) => {
      const existing = states.get(runId);
      if (!existing) return;
      states.set(runId, {
        ...existing,
        attempt: attempt ? clone(attempt) : null,
        updatedAt: new Date().toISOString(),
      });
    },
    request: async (runId, request) => {
      const existing = states.get(runId);
      if (!existing) return;
      states.set(runId, { ...existing, request, updatedAt: new Date().toISOString() });
    },
    runState: async (runId) => {
      const state = states.get(runId);
      return state ? clone(state) : null;
    },
    listRunStates: async (statuses) =>
      [...states.values()]
        .filter((s) => statuses.includes(s.status))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map(clone),
    checkpointsOf: async (runId) => (checkpoints.get(runId) ?? []).map(clone),
    close: async () => {},
  };
}

export function createPgFlowStore(url = getDatabaseUrl()): FlowStore {
  let handle: DbHandle | undefined;
  const db = () => (handle ??= createDb(url));
  const warn = (op: string, err: unknown) =>
    console.error(`[@lacrew/orchestrator] flow ${op} failed:`, err);

  /** The row shape both the checkpoint write and `startRun` upsert. */
  const runRow = (input: {
    runId: string;
    flowId: string;
    status: FlowRunLifecycle;
    principal?: string | null;
    trigger?: string | null;
    cursor?: string | null;
    state?: FlowResumeState | null;
    pause?: FlowWaiting | null;
    attempt?: FlowAttempt | null;
    startedAt: string;
  }) => ({
    runId: input.runId,
    flowId: input.flowId,
    status: input.status,
    principal: input.principal ?? null,
    trigger: input.trigger ?? null,
    cursor: input.cursor ?? null,
    state: (input.state ?? null) as Record<string, unknown> | null,
    pause: (input.pause ?? null) as Record<string, unknown> | null,
    attempt: (input.attempt ?? null) as Record<string, unknown> | null,
    startedAt: input.startedAt,
  });

  const toState = (row: {
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
  }): FlowRunState => ({
    runId: row.runId,
    flowId: row.flowId,
    status: row.status as FlowRunLifecycle,
    request: (row.request ?? null) as FlowRunRequest | null,
    principal: row.principal ?? null,
    trigger: row.trigger ?? null,
    cursor: row.cursor ?? null,
    state: (row.state ?? null) as FlowResumeState | null,
    pause: (row.pause ?? null) as FlowWaiting | null,
    attempt: (row.attempt ?? null) as FlowAttempt | null,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  });

  return {
    name: "postgres",
    save: async (def) => {
      try {
        await upsertFlowDefinition(db(), {
          id: def.id,
          name: def.name,
          definition: def as unknown as Record<string, unknown>,
          scopeLevel: def.scope?.level ?? null,
          scopeRef: def.scope?.ref ?? null,
        });
      } catch (err) {
        warn("save", err);
      }
    },
    remove: async (id) => {
      try {
        await deleteFlowDefinition(db(), id);
      } catch (err) {
        warn("remove", err);
      }
    },
    list: async () => {
      try {
        const rows = await listFlowDefinitions(db());
        return rows.map((row) => row.definition as unknown as FlowDefinition);
      } catch (err) {
        warn("list", err);
        return [];
      }
    },
    get: async (id) => {
      try {
        const row = await getFlowDefinition(db(), id);
        return row ? (row.definition as unknown as FlowDefinition) : null;
      } catch (err) {
        warn("get", err);
        return null;
      }
    },
    appendRun: async (run) => {
      try {
        await insertFlowRun(db(), {
          runId: run.runId,
          flowId: run.flowId,
          status: run.status,
          principal: run.principal?.agent ?? null,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run as unknown as Record<string, unknown>,
        });
      } catch (err) {
        warn("run append", err);
      }
      try {
        // The lifecycle row has to land on the run's real end state, or a
        // restart would find a finished run still marked in flight and offer
        // to resume work that is already done.
        await upsertFlowRunState(
          db(),
          runRow({
            runId: run.runId,
            flowId: run.flowId,
            status: run.status,
            principal: run.principal?.agent ?? null,
            trigger: run.trigger ?? null,
            cursor: run.resume?.stepId ?? null,
            state: run.resume ?? null,
            pause: run.waiting ?? null,
            startedAt: run.startedAt,
          }),
        );
      } catch (err) {
        warn("run state", err);
      }
    },
    recentRuns: async (limit) => {
      try {
        const rows = await recentFlowRuns(db(), limit);
        return rows.map((row) => row.result as unknown as FlowRunResult);
      } catch (err) {
        warn("runs list", err);
        return [];
      }
    },
    getRun: async (runId) => {
      try {
        const row = await getFlowRun(db(), runId);
        return row ? (row.result as unknown as FlowRunResult) : null;
      } catch (err) {
        warn("run get", err);
        return null;
      }
    },
    startRun: async (run) => {
      try {
        await upsertFlowRunState(
          db(),
          runRow({ ...run, status: "running", cursor: null, startedAt: run.startedAt }),
        );
      } catch (err) {
        // Not fatal: the first checkpoint upserts the same row, so a run that
        // could not announce itself still becomes recoverable one step in.
        warn("run start", err);
      }
    },
    checkpoint: async (cp) => {
      const state = await getFlowRunState(db(), cp.runId);
      await recordFlowCheckpoint(
        db(),
        {
          runId: cp.runId,
          seq: cp.seq,
          flowId: cp.flowId,
          stepId: cp.stepId,
          nextStepId: cp.nextStepId,
          status: cp.status,
          pause: (cp.pause ?? null) as Record<string, unknown> | null,
          state: (cp.state ?? null) as Record<string, unknown> | null,
          at: cp.at,
        },
        runRow({
          runId: cp.runId,
          flowId: cp.flowId,
          status: cp.status === "paused" ? "waiting" : "running",
          principal: state?.principal ?? null,
          trigger: state?.trigger ?? null,
          cursor: cp.nextStepId,
          state: cp.state ?? null,
          pause: cp.pause ?? null,
          // The step finished, so nothing is in flight any more.
          attempt: null,
          startedAt: state?.startedAt ?? cp.at,
        }),
      );
    },
    setAttempt: async (runId, attempt) => {
      await setFlowRunAttempt(db(), runId, (attempt ?? null) as Record<string, unknown> | null);
    },
    request: async (runId, request) => {
      try {
        await setFlowRunRequest(db(), runId, request);
      } catch (err) {
        warn("run request", err);
      }
    },
    runState: async (runId) => {
      try {
        const row = await getFlowRunState(db(), runId);
        return row ? toState(row) : null;
      } catch (err) {
        warn("run state read", err);
        return null;
      }
    },
    listRunStates: async (statuses) => {
      try {
        const rows = await listFlowRunStates(db(), statuses);
        return rows.map(toState);
      } catch (err) {
        warn("run states list", err);
        return [];
      }
    },
    checkpointsOf: async (runId) => {
      try {
        const rows = await listFlowCheckpoints(db(), runId);
        return rows.map((row) => ({
          runId: row.runId,
          flowId: row.flowId,
          seq: row.seq,
          stepId: row.stepId,
          nextStepId: row.nextStepId ?? null,
          status: row.status as "running" | "paused",
          ...(row.pause ? { pause: row.pause as unknown as FlowWaiting } : {}),
          ...(row.state ? { state: row.state as unknown as FlowResumeState } : {}),
          at: row.at,
        }));
      } catch (err) {
        warn("checkpoints list", err);
        return [];
      }
    },
    close: async () => {
      await handle?.close();
      handle = undefined;
    },
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createFlowStoreFromEnv(): FlowStore {
  return getDatabaseUrl() ? createPgFlowStore() : createMemoryFlowStore();
}
