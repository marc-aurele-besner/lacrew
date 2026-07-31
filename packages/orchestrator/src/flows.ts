/**
 * Flows surface: stores flow definitions and runs them against the live
 * runtime (model steps → ModelProvider, tool/gate steps → the same MCP
 * backend that signs session-gated onchain proposes). Definitions + run
 * traces persist through a FlowStore (Postgres when DATABASE_URL is set;
 * memory fallback keeps everything working detached).
 */

import {
  createMockFlowBackend,
  cronMatches,
  flowTemplates,
  runFlow,
  validateFlow,
  type FlowBackend,
  type FlowCheckpointSink,
  type FlowControl,
  type FlowDefinition,
  type FlowResumeState,
  type FlowRunResult,
  type FlowRunTrigger,
  type FlowCheckpoint,
  type FlowTemplate,
  type FlowTrigger,
} from "@lacrew/flows";
import { runMcpTool, type McpToolBackend } from "@lacrew/adapter-agents-mcp";
import type { OrgNode } from "@lacrew/core";
import type { ConnectorAskRecord, ConnectorAsksSurface } from "./connectorAsks.js";
import type { ConnectorRegistry } from "./connectors.js";
import {
  createFlowStoreFromEnv,
  type FlowRunState,
  type FlowStore,
} from "./flowStore.js";
import { ancestorsOf, ceilingAgent, scopeOf, scopeSessionLimits, visibleTo } from "./flowScope.js";
import { createRuntimeMcpBackend } from "./mcpBackend.js";
import type { ModelProvider } from "./model/index.js";
import type { CrewRuntime } from "./runtime.js";

const RUN_RING_MAX = 50;
/** Cron scheduler poll cadence — fine for minute-resolution schedules. */
const CRON_POLL_MS = 20_000;
/**
 * How deep `agent` steps may nest flow runs. Cycle validation only covers edges
 * *within* one definition, so a flowId reference is unchecked by it; without a
 * bound, a flow that delegates back into itself takes the process down.
 */
const MAX_DELEGATION_DEPTH = 4;

export type FlowsSurface = {
  /** Every flow, or only those `as` may see when a principal is given. */
  list(as?: string): Promise<FlowDefinition[]>;
  /**
   * One definition by id. `refresh` reads the store rather than this process's
   * map, which is what dispatched work needs: the replica that saved a flow and
   * the one handed its delivery are routinely different processes.
   */
  get(id: string, opts?: { refresh?: boolean }): Promise<FlowDefinition | undefined>;
  save(def: FlowDefinition): Promise<FlowDefinition>;
  remove(id: string): Promise<boolean>;
  run(input: {
    id?: string;
    flow?: FlowDefinition;
    input?: string;
    trigger?: FlowRunTrigger;
    /**
     * Caller-supplied run id. Lets a dispatcher name the run before the work
     * starts — a webhook answers its producer with a runId while the run is
     * still queued — and makes a redelivered job land on the same row.
     */
    runId?: string;
    /**
     * Read the definition from the store instead of this process's map.
     *
     * Set by dispatched work (webhook deliveries): the replica that saved a
     * flow and the one that runs it are routinely different, and a boot-time
     * map answers `flow_not_found` for everything saved since. Manual and
     * swept runs keep the map, which is already the definition their own
     * process was asked about.
     */
    refresh?: boolean;
    /** Agent the run executes as; defaults to the crew worker. */
    as?: `0x${string}`;
  }): Promise<FlowRunResult>;
  runs(): FlowRunResult[];
  templates(): FlowTemplate[];
  /**
   * Continue a run suspended on an ask-mode connector write (F2.24), from the
   * state stored on the ask. Called when the human answers, and when an
   * unanswered ask expires — the resumed step then refuses instead of calling.
   */
  resumeAsk(ask: ConnectorAskRecord): Promise<FlowRunResult | null>;
  /**
   * Ask a run to stop at its next step boundary (F2.26). A request rather than
   * a mutation: the run may be moving in another replica, and the only safe
   * place to honour it is between two steps.
   */
  pause(runId: string, detail?: string): Promise<FlowRunState>;
  /** Continue a paused run from its last checkpoint, as its original principal. */
  resume(runId: string): Promise<FlowRunResult>;
  /** End a run for good. Terminal — a cancelled run never resumes. */
  cancel(runId: string, reason?: string): Promise<FlowRunState>;
  /** Where a run is, as opposed to what it produced. */
  runState(runId: string): Promise<FlowRunState | null>;
  /** Runs parked or in flight, oldest first — the stalled-run list. */
  openRuns(): Promise<FlowRunState[]>;
  /** The checkpoint trail of one run, oldest → newest. */
  checkpoints(runId: string): Promise<FlowCheckpoint[]>;
  /**
   * Boot recovery: pick up runs whose process died mid-flight, and fail closed
   * on the ones that were mid-write. Paused runs are left alone — they are
   * waiting on something, not stalled.
   */
  hydrateRuns(): Promise<{ resumed: number; failed: number; paused: number }>;
  /** Run every saved flow with the given trigger (queue epoch hook). */
  runTriggered(trigger: FlowTrigger): Promise<FlowRunResult[]>;
  /** Run cron-triggered flows whose schedule matches `now` (once per minute). */
  runCronDue(now?: Date): Promise<FlowRunResult[]>;
  /**
   * Start/stop an in-process minute-resolution sweeper (idempotent), for
   * embedders driving flows without a QueueProvider. `startServer` schedules
   * the sweep on the queue instead — running both double-fires cron flows.
   */
  startCron(): void;
  stopCron(): void;
  /** Load persisted definitions + recent runs; returns counts for boot logs. */
  hydrate(): Promise<{ flows: number; runs: number }>;
  storeName: string;
};

export function createFlowsSurface(opts: {
  runtime: CrewRuntime;
  model: ModelProvider;
  /** Live MCP backend; omitted (LACREW_MCP_MOCK=1) falls back to the detached mock. */
  mcpBackend?: McpToolBackend;
  store?: FlowStore;
  /**
   * Operator-registered external surfaces (`<connector>.<route>` tool names).
   * Absent, a flow naming one gets "unknown tool" — the same answer it got
   * before connectors existed, rather than a silent no-op.
   */
  connectors?: ConnectorRegistry;
  /**
   * Ask-mode confirmations (F2.24). Given one, this surface registers itself as
   * the thing that resumes a suspended run when the answer lands.
   */
  asks?: ConnectorAsksSurface;
}): FlowsSurface {
  const store = opts.store ?? createFlowStoreFromEnv();
  const flows = new Map<string, FlowDefinition>();
  const runRing: FlowRunResult[] = [];
  const cronFiredAt = new Map<string, number>();
  let cronTimer: NodeJS.Timeout | null = null;
  const mocked = !opts.mcpBackend;

  /** Cached org chart for scope resolution; refreshed lazily per call. */
  const orgNodes = async (): Promise<OrgNode[]> => {
    try {
      return (await opts.runtime.getClient().getOrgTree()) as OrgNode[];
    } catch {
      // No reachable registry (mock/detached): scoping cannot be evaluated.
      return [];
    }
  };

  /**
   * A backend bound to one run's identity. Gate defaults, the policy ceiling,
   * and delegation all follow the principal rather than the process-wide worker.
   */
  const backendFor = (
    principal: `0x${string}`,
    ceiling: `0x${string}` | undefined,
    sessionLimits: ReturnType<typeof scopeSessionLimits>,
    chain: string[],
    /** Identifies the run to an ask-mode write, so it can be resumed. */
    run: { flowId: string; runId: string; managers: string[] },
  ): FlowBackend => {
    if (mocked) return createMockFlowBackend();
    const bound = createRuntimeMcpBackend(opts.runtime, {
      principal,
      ceiling,
      window: sessionLimits.window,
      rate: sessionLimits.rate,
      scopes: sessionLimits.scopes,
    });
    return {
      complete: (input) => opts.model.complete(input),
      callTool: async (name, args) => {
        if (name === "lacrew_invoke_agent") return delegate(args, chain);
        // Connectors are checked before the MCP dispatch so a `lacrew_*` name
        // can never be shadowed by a registered route.
        if (!name.startsWith("lacrew_") && opts.connectors?.handles(name)) {
          return opts.connectors.call(name, args, {
            principal,
            managers: run.managers,
            flowId: run.flowId,
            runId: run.runId,
          });
        }
        return runMcpTool(name, fillGateDefaults(name, args, principal, opts.runtime), {
          backend: bound,
        });
      },
    };
  };

  /**
   * Delegate to another agent: run `flowId` as that agent when given, else hand
   * the prompt to the model. The delegate's own policy stack applies because
   * the nested run gets its own principal — a flow cannot borrow authority by
   * invoking a more privileged agent.
   */
  const delegate = async (
    args: Record<string, unknown>,
    chain: string[],
  ): Promise<unknown> => {
    const agent = String(args.agent ?? "") as `0x${string}`;
    const flowId = args.flowId ? String(args.flowId) : undefined;
    if (flowId) {
      if (chain.includes(flowId)) {
        throw new Error(`flow_delegation_cycle: ${[...chain, flowId].join(" → ")}`);
      }
      if (chain.length >= MAX_DELEGATION_DEPTH) {
        throw new Error(
          `flow_delegation_too_deep: ${chain.length} levels (max ${MAX_DELEGATION_DEPTH})`,
        );
      }
      const result = await runOne(
        {
          id: flowId,
          input: args.prompt ? String(args.prompt) : undefined,
          as: agent,
        },
        chain,
      );
      if (result.status === "waiting") {
        // A nested run cannot be suspended and picked up later: the ask holds
        // the *child's* resume state, and releasing it would leave the parent
        // parked with nothing to continue it. Failing the delegating step says
        // so, rather than reporting a run that quietly did half its work.
        throw new Error(
          `flow_delegate_waiting (${flowId}): ${result.waiting?.detail ?? result.waiting?.reason ?? "waiting"}` +
            " — an ask-mode connector write cannot be confirmed inside a delegated flow",
        );
      }
      if (result.status === "error") {
        // A delegate that failed must fail the delegating step. Returning the
        // failure as data would let the parent run report "completed".
        const cause = result.steps.find((s) => s.status === "error")?.error ?? result.status;
        throw new Error(`flow_delegate_failed (${flowId}): ${cause}`);
      }
      return {
        agent,
        runId: result.runId,
        status: result.status,
        text: result.steps.at(-1)?.summary ?? result.status,
      };
    }
    // The identity line used to be the whole system prompt, which made every
    // agent in every org identical in disposition. It is now the first layer of
    // the agent's standing brief (agentControls.ts) and still leads it.
    const completion = await opts.model.complete({
      system: opts.runtime.systemPromptFor(agent),
      prompt: String(args.prompt ?? ""),
    });
    return { agent, text: completion.text, model: completion.model };
  };

  const pushRun = async (result: FlowRunResult): Promise<void> => {
    // A resumed run carries the id it suspended under, so it replaces its own
    // waiting entry rather than appearing twice — once stalled, once finished.
    const existing = runRing.findIndex((r) => r.runId === result.runId);
    if (existing >= 0) runRing.splice(existing, 1);
    runRing.push(result);
    if (runRing.length > RUN_RING_MAX) runRing.splice(0, runRing.length - RUN_RING_MAX);
    // Awaited, not fire-and-forget: this write also settles the run's lifecycle
    // row, and a boot that raced it would find a finished run still marked in
    // flight and offer to redo it. The store swallows its own errors.
    await store.appendRun(result);
  };

  /**
   * Durability, bound to the store. `record` and the attempt writes are the two
   * calls allowed to fail a run: everything else this surface persists is
   * history, and losing history is not the same as losing the ability to say
   * whether a payment went out.
   */
  const checkpointSink: FlowCheckpointSink = {
    record: (checkpoint) => store.checkpoint(checkpoint),
    begin: (attempt) => store.setAttempt(attempt.runId, attempt),
    settle: (attempt) => store.setAttempt(attempt.runId, null),
  };

  /**
   * Between every two steps, whether an operator asked this run to stop.
   *
   * The request is cleared as it is read: the run is about to act on it, and
   * leaving it set would re-pause the run the moment somebody resumed it. A
   * process that dies in that gap loses the request, and the run is picked back
   * up on the next boot — which is the same outcome as never having asked.
   */
  const controlFor = async ({ runId }: { runId: string }): Promise<FlowControl> => {
    const state = await store.runState(runId);
    const request = state?.request;
    if (request !== "pause" && request !== "cancel") return "continue";
    await store.request(runId, null);
    return request;
  };

  const runOne = async (
    input: {
      id?: string;
      flow?: FlowDefinition;
      input?: string;
      trigger?: FlowRunTrigger;
      runId?: string;
      refresh?: boolean;
      as?: `0x${string}`;
      /** Continue a suspended run rather than starting at the entry step. */
      resume?: FlowResumeState;
    },
    /** Flow ids already on the delegation stack; guards nested `agent` steps. */
    chain: string[] = [],
  ): Promise<FlowRunResult> => {
    const fresh =
      input.refresh && input.id && !input.flow ? await store.get(input.id) : null;
    if (fresh) flows.set(fresh.id, fresh);
    const def =
      input.flow ??
      fresh ??
      flows.get(input.id ?? "") ??
      flowTemplates.find((t) => t.definition.id === input.id)?.definition;
    if (!def) throw new Error("flow_not_found");

    const principal = input.as ?? opts.runtime.defaultAgent;
    const nodes = await orgNodes();
    if (input.as && !visibleTo(def, input.as, nodes)) {
      throw new Error("flow_out_of_scope");
    }

    const runId =
      input.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // A resumed run keeps the start it suspended under: the wait is part of how
    // long the run took, and a fresh stamp would report an hour's pause as new.
    const startedAt = input.resume?.startedAt ?? new Date().toISOString();
    await store.startRun({
      runId,
      flowId: def.id,
      principal,
      trigger: input.trigger ?? "manual",
      startedAt,
    });
    const result = await runFlow(
      def,
      backendFor(principal, ceilingAgent(def), scopeSessionLimits(def), [...chain, def.id], {
        flowId: def.id,
        runId,
        // Nearest-first, which is the order crew mode rules are resolved in.
        managers: [...ancestorsOf(nodes, principal)],
      }),
      {
        input: input.input,
        trigger: input.trigger,
        runId,
        principal: { agent: principal },
        mocked,
        checkpoints: checkpointSink,
        control: controlFor,
        ...(input.resume ? { resume: input.resume } : {}),
      },
    );
    await pushRun(result);
    // The suspended run is attached to the thing holding it up, so whichever
    // replica handles the answer can continue it. Without this the run is a
    // trace nobody can pick back up.
    if (result.status === "waiting" && result.resume && result.waiting?.token) {
      await opts.asks?.attachResume(result.waiting.token, result.resume);
    }
    opts.runtime.recordAudit({
      type: "FlowRun",
      at: result.finishedAt,
      payload: {
        flowId: result.flowId,
        runId: result.runId,
        status: result.status,
        trigger: result.trigger ?? "manual",
        principal,
        scope: scopeOf(def),
        steps: result.steps.length,
        verdicts: result.steps.filter((s) => s.verdict).map((s) => s.verdict),
        mocked: result.mocked ?? false,
        ...(result.waiting ? { waiting: result.waiting.reason } : {}),
      },
    });
    return result;
  };

  const resumeAsk = async (ask: ConnectorAskRecord): Promise<FlowRunResult | null> => {
    if (!ask.resume || !ask.flowId) return null;
    try {
      return await runOne({
        id: ask.flowId,
        runId: ask.runId,
        as: ask.principal ? (ask.principal as `0x${string}`) : undefined,
        resume: ask.resume,
      });
    } catch (err) {
      console.error(`[@lacrew/orchestrator] resuming flow "${ask.flowId}" failed:`, err);
      return null;
    }
  };
  opts.asks?.setResumer(async (ask) => {
    await resumeAsk(ask);
  });

  /** Statuses a run cannot come back from. `waiting` is the one that can. */
  const TERMINAL = new Set(["completed", "error", "max_steps", "cancelled"]);

  const requireState = async (runId: string): Promise<FlowRunState> => {
    const state = await store.runState(runId);
    if (!state) throw new Error("run_not_found");
    return state;
  };

  /**
   * A run result assembled from durable state rather than from an execution.
   *
   * Cancelling a parked run and failing a crashed one both end runs that no
   * process is holding, and both still owe the trail a record: the steps that
   * did happen, plus one line saying how it ended.
   */
  const resultFrom = (
    state: FlowRunState,
    status: FlowRunResult["status"],
    lastStep?: FlowRunResult["steps"][number],
  ): FlowRunResult => {
    const def = flows.get(state.flowId);
    const steps = [...(state.state?.steps ?? []), ...(lastStep ? [lastStep] : [])];
    return {
      runId: state.runId,
      flowId: state.flowId,
      ...(def?.name ? { flowName: def.name } : {}),
      status,
      trigger: (state.trigger ?? "manual") as FlowRunTrigger,
      ...(state.principal ? { principal: { agent: state.principal } } : {}),
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      ...(state.state?.input === undefined ? {} : { input: state.state.input }),
      steps,
      mocked,
    };
  };

  const pause = async (runId: string, detail?: string): Promise<FlowRunState> => {
    const state = await requireState(runId);
    if (TERMINAL.has(state.status)) throw new Error(`run_not_pausable:${state.status}`);
    // Already parked: asking again is not an error, and re-requesting would
    // pause the run again the instant somebody resumed it.
    if (state.status === "waiting") return state;
    await store.request(runId, "pause");
    opts.runtime.recordAudit({
      type: "FlowRunLifecycle",
      at: new Date().toISOString(),
      payload: {
        action: "pause",
        runId,
        flowId: state.flowId,
        requested: true,
        ...(detail ? { detail } : {}),
      },
    });
    return { ...state, request: "pause" };
  };

  const cancel = async (runId: string, reason?: string): Promise<FlowRunState> => {
    const state = await requireState(runId);
    if (state.status === "cancelled") return state;
    if (TERMINAL.has(state.status)) throw new Error(`run_not_cancellable:${state.status}`);
    if (state.status === "waiting") {
      // Nothing is holding a parked run, so the cancel lands now rather than
      // waiting for a worker that is never coming back to it.
      await pushRun(
        resultFrom(state, "cancelled", {
          stepId: state.cursor ?? state.pause?.stepId ?? "cancel",
          kind: "branch",
          status: "error",
          error: `cancelled${reason ? `: ${reason}` : ""}`,
          next: null,
          ms: 0,
        }),
      );
      opts.runtime.recordAudit({
        type: "FlowRunLifecycle",
        at: new Date().toISOString(),
        payload: { action: "cancel", runId, flowId: state.flowId, ...(reason ? { reason } : {}) },
      });
      return (await store.runState(runId)) ?? { ...state, status: "cancelled" };
    }
    await store.request(runId, "cancel");
    opts.runtime.recordAudit({
      type: "FlowRunLifecycle",
      at: new Date().toISOString(),
      payload: {
        action: "cancel",
        runId,
        flowId: state.flowId,
        requested: true,
        ...(reason ? { reason } : {}),
      },
    });
    return { ...state, request: "cancel" };
  };

  const resume = async (runId: string): Promise<FlowRunResult> => {
    const state = await requireState(runId);
    if (state.status === "cancelled") throw new Error("run_cancelled");
    if (state.status !== "waiting") throw new Error(`run_not_resumable:${state.status}`);
    if (!state.state) throw new Error("run_has_no_checkpoint");
    const principal = state.principal as `0x${string}` | undefined;
    // Same principal as the original run, or nothing: a resume that reached for
    // a different (or a paused) identity would launder authority through a
    // pause, which is the one thing durable state must never buy.
    if (principal && opts.runtime.isAgentPaused(principal)) {
      throw new Error(`run_principal_paused:${principal}`);
    }
    await store.request(runId, null);
    return runOne({
      id: state.flowId,
      runId,
      ...(principal ? { as: principal } : {}),
      ...(state.trigger ? { trigger: state.trigger as FlowRunTrigger } : {}),
      resume: state.state,
    });
  };

  const surface: FlowsSurface = {
    list: async (as) => {
      const all = [...flows.values()];
      if (!as) return all;
      const nodes = await orgNodes();
      return all.filter((def) => visibleTo(def, as, nodes));
    },
    get: async (id, getOpts) => {
      if (getOpts?.refresh) {
        const stored = await store.get(id);
        if (stored) {
          flows.set(stored.id, stored);
          return stored;
        }
      }
      return (
        flows.get(id) ?? flowTemplates.find((t) => t.definition.id === id)?.definition
      );
    },
    save: async (def) => {
      const check = validateFlow(def);
      if (!check.ok) throw new Error(`invalid_flow: ${check.errors.join("; ")}`);
      flows.set(def.id, structuredClone(def));
      await store.save(def);
      opts.runtime.recordAudit({
        type: "FlowSaved",
        at: new Date().toISOString(),
        payload: {
          flowId: def.id,
          name: def.name,
          steps: def.steps.length,
          trigger: def.trigger ?? "manual",
        },
      });
      return def;
    },
    remove: async (id) => {
      const existed = flows.delete(id);
      if (existed) await store.remove(id);
      return existed;
    },
    run: runOne,
    resumeAsk,
    pause,
    resume,
    cancel,
    runState: (runId) => store.runState(runId),
    openRuns: () => store.listRunStates(["running", "waiting"]),
    checkpoints: (runId) => store.checkpointsOf(runId),
    runs: () => [...runRing].reverse(),
    templates: () => flowTemplates,
    runCronDue: async (now = new Date()) => {
      const minuteKey = Math.floor(now.getTime() / 60_000);
      const results: FlowRunResult[] = [];
      for (const def of flows.values()) {
        if (def.trigger !== "cron" || !def.schedule) continue;
        if (!cronMatches(def.schedule, now)) continue;
        if (cronFiredAt.get(def.id) === minuteKey) continue;
        cronFiredAt.set(def.id, minuteKey);
        try {
          results.push(await runOne({ id: def.id, trigger: "cron" }));
        } catch (err) {
          console.error(`[@lacrew/orchestrator] cron flow "${def.id}" failed:`, err);
        }
      }
      return results;
    },
    startCron: () => {
      if (cronTimer) return;
      cronTimer = setInterval(() => {
        void surface.runCronDue();
      }, CRON_POLL_MS);
      cronTimer.unref?.();
    },
    stopCron: () => {
      if (cronTimer) clearInterval(cronTimer);
      cronTimer = null;
    },
    runTriggered: async (trigger) => {
      const due = [...flows.values()].filter((f) => (f.trigger ?? "manual") === trigger);
      const results: FlowRunResult[] = [];
      for (const def of due) {
        try {
          results.push(await runOne({ id: def.id, trigger }));
        } catch (err) {
          console.error(`[@lacrew/orchestrator] ${trigger} flow "${def.id}" failed:`, err);
        }
      }
      return results;
    },
    hydrate: async () => {
      for (const def of await store.list()) flows.set(def.id, def);
      const persisted = await store.recentRuns(RUN_RING_MAX);
      // recentRuns is newest → oldest; the ring wants oldest first.
      for (const run of [...persisted].reverse()) runRing.push(run);
      return { flows: flows.size, runs: runRing.length };
    },
    hydrateRuns: async () => {
      let resumed = 0;
      let failed = 0;
      let paused = 0;
      for (const state of await store.listRunStates(["running", "waiting"])) {
        // A parked run is not stalled work: something is expected to release
        // it (an ask answer, an operator, a webhook), and picking it up here
        // would run the very step it was told to stop before.
        if (state.status === "waiting") {
          paused++;
          continue;
        }
        // The run finished but its lifecycle row never caught up — a crash
        // between the trace write and the state write. Reconcile to what the
        // trace says rather than redoing work that plainly completed.
        const finished = await store.getRun(state.runId);
        if (finished && finished.status !== "waiting") {
          await pushRun(finished);
          continue;
        }
        const attempt = state.attempt;
        if (attempt && !attempt.idempotent) {
          // The default the PRD asks for: a write whose result nobody recorded
          // is not retried. Redoing it could pay twice; skipping it could skip
          // a payment. Only a human knows which happened, so the run fails
          // loudly with the attempt key to reconcile against.
          await pushRun(
            resultFrom(state, "error", {
              stepId: attempt.stepId,
              kind: attempt.kind,
              status: "error",
              error:
                `incomplete_write_attempt:${attempt.stepId} (${attempt.key}) — the process ` +
                "stopped after this step started and before it finished. It is not retried: " +
                "mark the step idempotent if repeating it is safe, else reconcile by hand.",
              next: null,
              ms: 0,
            }),
          );
          console.error(
            `[@lacrew/orchestrator] flow run ${state.runId} failed closed on an incomplete ` +
              `write at step "${attempt.stepId}" (${attempt.key})`,
          );
          failed++;
          continue;
        }
        if (!state.state) {
          // In flight with no checkpoint: the process died inside the first
          // step. Nothing says what ran, so it is not guessed at.
          await pushRun(
            resultFrom(state, "error", {
              stepId: state.cursor ?? "start",
              kind: "branch",
              status: "error",
              error: "no_checkpoint — the run stopped before its first step was recorded",
              next: null,
              ms: 0,
            }),
          );
          failed++;
          continue;
        }
        try {
          const principal = state.principal as `0x${string}` | undefined;
          const result = await runOne({
            id: state.flowId,
            runId: state.runId,
            // Read through: the replica recovering a run is rarely the one
            // that saved the flow.
            refresh: true,
            ...(principal ? { as: principal } : {}),
            ...(state.trigger ? { trigger: state.trigger as FlowRunTrigger } : {}),
            resume: state.state,
          });
          if (result.status === "error") failed++;
          else resumed++;
        } catch (err) {
          console.error(
            `[@lacrew/orchestrator] resuming flow run ${state.runId} failed:`,
            err,
          );
          failed++;
        }
      }
      return { resumed, failed, paused };
    },
    storeName: store.name,
  };
  return surface;
}

/**
 * Gate steps may omit agent/target; fill them from the runtime's crew worker
 * and configured spend target so flows stay portable across orgs.
 */
function fillGateDefaults(
  name: string,
  args: Record<string, unknown>,
  principal: `0x${string}`,
  runtime: CrewRuntime,
): Record<string, unknown> {
  if (name !== "lacrew_propose_intent" && name !== "lacrew_check_policy") return args;
  return {
    // The run's principal, not the process-wide worker.
    agent: args.agent ?? principal,
    target: args.target ?? runtime.defaultSpendTarget,
    ...args,
    value: String(args.value ?? "0"),
  };
}
