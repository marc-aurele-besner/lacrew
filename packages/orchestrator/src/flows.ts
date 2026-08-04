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
  FlowWaitingError,
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
import type { HumanGateRecord, HumanGatesSurface } from "./humanGates.js";
import type { ConnectorRegistry } from "./connectors.js";
import type { ExternalMcpRegistry } from "./externalMcp.js";
import { isPlanRequired, type PlanRequirementsSurface } from "./planRequired.js";
import type { DualControlReviewRecord, DualControlSurface } from "./dualControl.js";
import {
  createFlowStoreFromEnv,
  type FlowRunState,
  type FlowStore,
} from "./flowStore.js";
import { ancestorsOf, ceilingAgent, scopeOf, scopeSessionLimits, visibleTo } from "./flowScope.js";
import { crewIdForSeat } from "./inferenceBudgets.js";
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
   * Continue a run parked on a blocking human gate (F2.27), from the state
   * stored on the gate. Called when a person answers, and when an unanswered
   * gate times out — the resumed step then takes the timeout port, or stops.
   */
  resumeGate(gate: HumanGateRecord): Promise<FlowRunResult | null>;
  /**
   * Continue a run parked on a dual-control review (F2.32), from the state
   * stored on the review. Called when a second seat concurs or rejects, and
   * when an unanswered review times out — the resumed step then acts, or fails
   * closed.
   */
  resumeReview(review: DualControlReviewRecord): Promise<FlowRunResult | null>;
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
   * Attached third-party MCP servers (`mcp__<server>__<tool>` tool names,
   * F2.30). Absent, a flow naming one gets "unknown tool" — never a silent
   * no-op, and never a call: the allowlist lives in the registry.
   */
  externalMcp?: ExternalMcpRegistry;
  /**
   * Ask-mode confirmations (F2.24). Given one, this surface registers itself as
   * the thing that resumes a suspended run when the answer lands.
   */
  asks?: ConnectorAsksSurface;
  /**
   * Blocking human gates (F2.27). Given one, a `human` step asks it whether the
   * run may continue, and this surface registers itself as the thing that
   * resumes the run once someone answers. Absent, a `human` step fails rather
   * than passing: a gate nobody can answer must never read as a yes.
   */
  gates?: HumanGatesSurface;
  /**
   * Plan-required mode (F2.31). Given one, every side-effecting tool call is
   * checked against it *before* dispatch. Absent, crews behave as they did
   * before the mode existed — which is also what an unreadable rule set means:
   * this control guards legibility, not authority, and everything it sits in
   * front of is still bounded by the policy stack.
   */
  planRequired?: PlanRequirementsSurface;
  /**
   * Dual control (F2.32). Given one, a matching side effect parks the run on a
   * review by a second seat before anything is dispatched. Absent, crews behave
   * as they did before the control existed — and unlike plan-required, that is
   * *not* what an unreadable rule set means: this control fails closed, so the
   * process that could not read its rules keeps the surface wired and refuses.
   */
  dualControl?: DualControlSurface;
}): FlowsSurface {
  /** Statuses a run cannot come back from. `waiting` is the one that can. */
  const TERMINAL = new Set(["completed", "error", "max_steps", "cancelled"]);

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
   * How the operator's own surfaces are classified for plan-required (F2.31).
   *
   * Only the registry holding a route or an external tool knows whether it
   * reads or writes; an unknown name stays unclassified and is treated as a
   * write by the checker, which is the cautious direction.
   */
  const effectOf = (tool: string): "read" | "write" | undefined =>
    opts.connectors?.effectOf(tool) ?? opts.externalMcp?.effectOf(tool);

  /**
   * Refuse a side effect the principal has not planned (F2.31).
   *
   * Asked before anything is built, so a refusal means no request was formed,
   * no policy was consulted and nothing left the process. A checker that fails
   * for its *own* reasons never stops the run: the requirement is a supervision
   * control, and everything behind it is still bounded by the policy stack.
   */
  const requirePlan = async (
    tool: string,
    principal: `0x${string}`,
    run: { flowId: string; runId: string; startedAt: string; managers: string[]; upstream?: string[] },
  ): Promise<void> => {
    if (!opts.planRequired) return;
    try {
      await opts.planRequired.check({
        tool,
        principal,
        managers: run.managers,
        runId: run.runId,
        runStartedAt: run.startedAt,
        flowId: run.flowId,
        ...(run.upstream?.length ? { upstream: run.upstream } : {}),
        effectOf,
      });
    } catch (err) {
      if (isPlanRequired(err)) throw err;
      console.error(
        `[@lacrew/orchestrator] plan-required check failed for ${tool}; the call is proceeding:`,
        err,
      );
    }
  };

  /**
   * Require a second seat's concurrence before this effect (F2.32).
   *
   * Asked after plan-required and still before anything is built, so a parked
   * run means no request was formed and nothing left the process. Unlike the
   * plan check, a failure *inside* this checker stops the run: dual control is
   * the second pair of eyes an operator put in front of a merge or a spend, and
   * a checker that failed open would deliver precisely the unreviewed effect
   * they were paying to prevent. `FlowWaitingError` and the refusal both
   * propagate — the first parks the run, the second ends the step.
   */
  const requireConcurrence = async (
    tool: string,
    args: Record<string, unknown>,
    principal: `0x${string}`,
    run: { flowId: string; runId: string; managers: string[] },
  ): Promise<void> => {
    if (!opts.dualControl) return;
    await opts.dualControl.check({
      tool,
      args,
      principal,
      managers: run.managers,
      runId: run.runId,
      flowId: run.flowId,
      effectOf,
    });
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
    run: { flowId: string; runId: string; startedAt: string; managers: string[]; upstream?: string[] },
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
      // Every completion says who it is for, so a cost budget (F2.28) can
      // charge it. Advisory context, never authority: `meta` cannot widen a
      // scope, and an unattributed call is still metered — under `unattributed`
      // — rather than escaping the count.
      complete: (input) =>
        opts.model.complete({
          ...input,
          meta: {
            crewId: crewIdForSeat(principal, run.managers),
            agentId: principal,
            flowId: run.flowId,
            runId: run.runId,
          },
        }),
      callTool: async (name, args) => {
        // Before every dispatch below, so "blocked" means nothing was built and
        // nothing went out. Reads and the conversation tools classify as no
        // effect and pass straight through.
        await requirePlan(name, principal, run);
        // Then the second pair of eyes, in that order: an agent that has not
        // said what it intends has nothing for a reviewer to read, so asking
        // for review first would put a question in front of a person before the
        // plan they need to answer it exists.
        await requireConcurrence(name, args, principal, run);
        if (name === "lacrew_invoke_agent") return delegate(args, chain, principal, run);
        if (name === "lacrew_human_gate") return humanGate(args, principal, run);
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
        // External MCP tools carry their own `mcp__<server>__<tool>` namespace,
        // so they can neither shadow a `lacrew_*` tool nor a connector route.
        // The registry decides whether this seat may call it at all.
        if (opts.externalMcp?.handles(name)) {
          return opts.externalMcp.call(name, args, {
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
   * Ask the gate surface whether a `human` step may continue.
   *
   * With no surface wired there is nobody to ask, and the step fails: a gate is
   * the thing standing between a pipeline and a side effect, so "no human
   * surface" has to stop the run, never release it.
   */
  const humanGate = async (
    args: Record<string, unknown>,
    principal: `0x${string}`,
    run: { flowId: string; runId: string },
  ): Promise<unknown> => {
    if (!opts.gates) throw new Error("human_gate_unavailable");
    const declared = Array.isArray(args.options) ? args.options : [];
    return opts.gates.gate({
      stepId: String(args.stepId ?? ""),
      prompt: String(args.prompt ?? ""),
      options: declared.map((o) => {
        const option = (o ?? {}) as { id?: unknown; label?: unknown };
        const id = String(option.id ?? "");
        return { id, label: String(option.label ?? id) };
      }),
      ...(args.assignee ? { assignee: String(args.assignee) } : {}),
      ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
      principal,
      flowId: run.flowId,
      runId: run.runId,
    });
  };

  /**
   * The finished trace of a run, from this process's ring or the store.
   *
   * The ring is asked first because it is the only place a memory-store
   * deployment keeps one, and it is also the cheaper read where both have it.
   */
  const finishedRun = async (runId: string): Promise<FlowRunResult | null> => {
    const local = runRing.find((r) => r.runId === runId);
    if (local) return local;
    return store.getRun(runId);
  };

  /**
   * What the delegating step gets back, given where the delegated run got to.
   *
   * Three answers, and only one of them is a value. A child still parked (or
   * still moving in another replica) suspends the *parent* on `awaiting_child`
   * — the run is durable, the child's own question is answered where it was
   * asked, and the parent is woken when the child ends. A child that failed or
   * was cancelled fails the step, because returning that as data would let the
   * parent report "completed". Anything else returns the delegate's outcome.
   */
  const delegateOutcome = async (input: {
    flowId: string;
    agent: `0x${string}`;
    childRunId: string;
    status: string;
    /** The child's own pause line, for the parent's stalled-run entry. */
    waiting?: string;
    /** Set when the child ended in this call, so its trace is already in hand. */
    result?: FlowRunResult;
  }): Promise<unknown> => {
    if (!TERMINAL.has(input.status)) {
      throw new FlowWaitingError({
        reason: "awaiting_child",
        token: input.childRunId,
        detail:
          `waiting on delegated run ${input.childRunId} (${input.flowId})` +
          (input.waiting ? `: ${input.waiting}` : ""),
      });
    }
    if (input.status === "cancelled") {
      throw new Error(
        `flow_delegate_cancelled (${input.flowId}): delegated run ${input.childRunId} was cancelled`,
      );
    }
    const result = input.result ?? (await finishedRun(input.childRunId));
    if (input.status !== "completed") {
      // A delegate that failed must fail the delegating step. Returning the
      // failure as data would let the parent run report "completed".
      const cause = result?.steps.find((s) => s.status === "error")?.error ?? input.status;
      throw new Error(`flow_delegate_failed (${input.flowId}): ${cause}`);
    }
    return {
      agent: input.agent,
      runId: input.childRunId,
      status: input.status,
      text: result?.steps.at(-1)?.summary ?? input.status,
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
    caller: `0x${string}`,
    run: { flowId: string; runId: string; startedAt: string; managers: string[]; upstream?: string[] },
  ): Promise<unknown> => {
    const agent = String(args.agent ?? "") as `0x${string}`;
    const flowId = args.flowId ? String(args.flowId) : undefined;
    // The engine names the step so a resumed parent can find the run it already
    // delegated. A caller that did not name one gets the old behaviour: the
    // delegate runs, and a parked one fails the step rather than parking a
    // parent nothing could ever wake.
    const stepId = String(args.stepId ?? "");
    if (flowId) {
      if (stepId) {
        // Re-entering this step after a pause: the child it started is the run
        // to read, whatever state it is in. Starting a second one is the double
        // delegation the (parent, step) uniqueness refuses at the table.
        const existing = await store.childRun(run.runId, stepId);
        if (existing) {
          return delegateOutcome({
            flowId,
            agent,
            childRunId: existing.runId,
            status: existing.status,
            ...(existing.pause?.detail ? { waiting: existing.pause.detail } : {}),
          });
        }
      }
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
          // Who handed the work down, for plan-required (F2.31). The delegate
          // is still the seat that must have planned — this only matters where
          // a rule says a manager's plan covers its workers.
          upstream: [caller, ...(run.upstream ?? [])],
          ...(stepId ? { parent: { runId: run.runId, stepId } } : {}),
        },
        chain,
      );
      if (result.status === "waiting" && !stepId) {
        // No step id, so no link back: the ask holds the child's resume state
        // and nothing could pair the answer with this run. Failing says so,
        // rather than reporting a run that quietly did half its work.
        throw new Error(
          `flow_delegate_waiting (${flowId}): ${result.waiting?.detail ?? result.waiting?.reason ?? "waiting"}` +
            " — the delegating step was not named, so the parent cannot be parked on it",
        );
      }
      return delegateOutcome({
        flowId,
        agent,
        childRunId: result.runId,
        status: result.status,
        ...(result.waiting?.detail ? { waiting: result.waiting.detail } : {}),
        result,
      });
    }
    // The identity line used to be the whole system prompt, which made every
    // agent in every org identical in disposition. It is now the first layer of
    // the agent's standing brief (agentControls.ts) and still leads it.
    const completion = await opts.model.complete({
      system: opts.runtime.systemPromptFor(agent),
      prompt: String(args.prompt ?? ""),
      // Charged to the *delegating* crew, and to the delegate as the seat. The
      // prompt was issued by this run, so the desk that started it pays for it
      // — a crew must not be able to shift its inference bill by routing work
      // through a seat on another crew's budget.
      meta: {
        crewId: crewIdForSeat(caller, run.managers),
        agentId: agent,
        flowId: run.flowId,
        runId: run.runId,
      },
    });
    return { agent, text: completion.text, model: completion.model };
  };

  /**
   * Continue a run whose claim this caller already holds.
   *
   * Separate from `resume` because the claim is what makes a wake safe, and the
   * caller that took it is the one that must spend it: re-reading the run here
   * would find it `running` and refuse to continue the very run it just took.
   */
  const resumeClaimed = async (state: FlowRunState): Promise<FlowRunResult> => {
    if (!state.state) throw new Error("run_has_no_checkpoint");
    const principal = state.principal as `0x${string}` | undefined;
    // Same principal as the original run, or nothing: a resume that reached for
    // a different (or a paused) identity would launder authority through a
    // pause, which is the one thing durable state must never buy.
    if (principal && opts.runtime.isAgentPaused(principal)) {
      throw new Error(`run_principal_paused:${principal}`);
    }
    await store.request(state.runId, null);
    return runOne({
      id: state.flowId,
      runId: state.runId,
      // The replica that wakes a run is rarely the one that saved its flow.
      refresh: true,
      ...(principal ? { as: principal } : {}),
      ...(state.trigger ? { trigger: state.trigger as FlowRunTrigger } : {}),
      resume: state.state,
    });
  };

  /**
   * Continue a run parked on a delegated child, once — whoever gets there first.
   *
   * Two things race to do this: the child ending, and the parent finishing the
   * write that parked it. Both call here, the claim settles which one continues
   * the run, and the loser does nothing. A claim this caller took and then
   * failed to spend leaves the run marked in flight, which is exactly what boot
   * recovery picks up.
   */
  const wakeDelegator = async (parentRunId: string): Promise<void> => {
    const claimed = await store.claimWaiting(parentRunId);
    if (!claimed) return;
    try {
      await resumeClaimed(claimed);
    } catch (err) {
      console.error(
        `[@lacrew/orchestrator] resuming run ${parentRunId} after its delegated run ended failed:`,
        err,
      );
    }
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
    // Every way a run can end passes through here — its own last step, a
    // cancel, a boot that failed it closed — so this is the one place that has
    // to notice a delegating run waiting on it (F2.24 / F2.27).
    if (!TERMINAL.has(result.status)) return;
    const parentRunId = (await store.runState(result.runId))?.parentRunId;
    if (parentRunId) await wakeDelegator(parentRunId);
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
      /** Seats that delegated this run, nearest-first (F2.31). */
      upstream?: string[];
      /**
       * The run and step that delegated this one (F2.24 / F2.27). Recorded on
       * the run's durable state, which is how a parked parent is found again
       * when this run ends — and how a resumed parent finds this run instead of
       * starting a second one.
       */
      parent?: { runId: string; stepId: string };
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
      ...(input.parent
        ? { parentRunId: input.parent.runId, parentStepId: input.parent.stepId }
        : {}),
    });
    const result = await runFlow(
      def,
      backendFor(principal, ceilingAgent(def), scopeSessionLimits(def), [...chain, def.id], {
        flowId: def.id,
        runId,
        startedAt,
        // Nearest-first, which is the order crew mode rules are resolved in.
        managers: [...ancestorsOf(nodes, principal)],
        ...(input.upstream?.length ? { upstream: input.upstream } : {}),
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
    // A run parked on a delegated one has nothing to attach: it is held by
    // another run, whose question is asked and answered where it was raised.
    if (
      result.status === "waiting" &&
      result.resume &&
      result.waiting?.token &&
      result.waiting.reason !== "awaiting_child"
    ) {
      // Every surface is asked; each ignores a token it does not own, which
      // keeps the run from having to know what parked it.
      await opts.asks?.attachResume(result.waiting.token, result.resume);
      await opts.gates?.attachResume(result.waiting.token, result.resume);
      await opts.dualControl?.attachResume(result.waiting.token, result.resume);
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
    // The delegated run may have ended while this one was still writing the
    // pause that parked it on that very run — its wake would have found this
    // run still marked in flight and left it alone. Nobody else is coming back
    // for it, so it checks the run it is waiting on for itself. The claim makes
    // the two orderings settle the same way.
    if (result.status === "waiting" && result.waiting?.reason === "awaiting_child") {
      const child = result.waiting.token ? await store.runState(result.waiting.token) : null;
      if (child && TERMINAL.has(child.status)) await wakeDelegator(runId);
    }
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

  const resumeGate = async (gate: HumanGateRecord): Promise<FlowRunResult | null> => {
    if (!gate.resume || !gate.flowId) return null;
    try {
      return await runOne({
        id: gate.flowId,
        ...(gate.runId ? { runId: gate.runId } : {}),
        as: gate.principal ? (gate.principal as `0x${string}`) : undefined,
        resume: gate.resume,
      });
    } catch (err) {
      console.error(`[@lacrew/orchestrator] resuming flow "${gate.flowId}" failed:`, err);
      return null;
    }
  };
  opts.gates?.setResumer(async (gate) => {
    await resumeGate(gate);
  });

  const resumeReview = async (review: DualControlReviewRecord): Promise<FlowRunResult | null> => {
    if (!review.resume || !review.flowId) return null;
    try {
      return await runOne({
        id: review.flowId,
        ...(review.runId ? { runId: review.runId } : {}),
        as: review.actor ? (review.actor as `0x${string}`) : undefined,
        resume: review.resume,
      });
    } catch (err) {
      console.error(`[@lacrew/orchestrator] resuming flow "${review.flowId}" failed:`, err);
      return null;
    }
  };
  opts.dualControl?.setResumer(async (review) => {
    await resumeReview(review);
  });

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

  /**
   * End the runs this one delegated, after it is itself past cancelling.
   *
   * Cancel is the documented policy, not abandonment: a delegated run holds a
   * session-scoped principal and an open question, and leaving it runnable
   * behind a cancelled parent is a pipeline that spends on work nobody is
   * waiting for. Recursive, so a chain ends at every level; each child's own
   * cancel closes its gates and asks.
   *
   * Called only once the parent can no longer be woken, because a child ending
   * is a wake signal — reversing the order would resume the run being cancelled.
   */
  const cancelChildren = async (parentRunId: string, reason?: string): Promise<void> => {
    for (const child of await store.childRuns(parentRunId)) {
      if (TERMINAL.has(child.status)) continue;
      try {
        await cancel(child.runId, reason ?? `delegating run ${parentRunId} was cancelled`);
      } catch (err) {
        console.error(`[@lacrew/orchestrator] cancelling delegated run ${child.runId} failed:`, err);
      }
    }
  };

  const cancel = async (runId: string, reason?: string): Promise<FlowRunState> => {
    const state = await requireState(runId);
    if (state.status === "cancelled") return state;
    if (TERMINAL.has(state.status)) throw new Error(`run_not_cancellable:${state.status}`);
    // Close the questions this run is holding open first. A gate outliving its
    // run is one a person can still answer, and answering it would resume a run
    // the operator ended (F2.27). An ask outlives its run the same way, and so
    // does a review, whose late concurrence must not restart an effect the
    // operator cancelled.
    await opts.gates?.cancelRun(runId, reason);
    await opts.asks?.cancelRun(runId, reason);
    await opts.dualControl?.cancelRun(runId, reason);
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
      await cancelChildren(runId, reason);
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
    // A run still moving stops at its next step boundary, but a delegate it is
    // blocked on would never reach one — it is waiting on a person. Ending the
    // child now is what makes the parent's own cancel land instead of hanging.
    await cancelChildren(runId, reason);
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
    // pause, which is the one thing durable state must never buy. Checked
    // before the claim, so a refusal leaves the run parked rather than marking
    // it in flight for a resume that never happened.
    if (principal && opts.runtime.isAgentPaused(principal)) {
      throw new Error(`run_principal_paused:${principal}`);
    }
    // An operator pressing Resume races everything else that can wake a run —
    // a delegated child ending, another replica's boot. The claim decides.
    const claimed = await store.claimWaiting(runId);
    if (!claimed) throw new Error("run_not_resumable:already_claimed");
    return resumeClaimed(claimed);
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
    resumeGate,
    resumeReview,
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
