/**
 * @lacrew/flows — declarative agent logic flows (pipelines) over LaCrew.
 *
 * A flow is a small DAG of steps (model calls, LaCrew MCP tools, policy-gated
 * spends, branches) that the orchestrator executes against its live runtime.
 * The same definition powers the visual builder (UX-first) and the code-first
 * SDK path: definitions are plain JSON, buildable with the fluent `flow()` API
 * and renderable back to TypeScript via `flowToCode()`.
 *
 * Flows never hold keys and never touch the treasury: every onchain effect is
 * policy-checked first and then either executed as the running principal or
 * routed into governance, so policy stacks and escalation apply exactly as they
 * do for any other agent action.
 */

export type Verdict = "ALLOW" | "ESCALATE" | "DENY";

/**
 * How widely a flow is published inside an org.
 * - `org`   — every node may see and invoke it.
 * - `team`  — the node at `scope.ref` and its descendants (a subtree of the org chart).
 * - `agent` — the single agent at `scope.ref` (its managers may still inspect it).
 */
export type FlowScopeLevel = "org" | "team" | "agent";

export type FlowScope = {
  level: FlowScopeLevel;
  /** Team root node address for "team", agent address for "agent"; optional org id for "org". */
  ref?: string;
  /**
   * Daily UTC window `[start, end)` in seconds a run's session key may propose
   * in; the chain (EscalationRouter) refuses proposes outside it. Any level.
   */
  window?: { start: number; end: number };
  /**
   * At most `maxProposals` proposes per `ratePeriod` seconds for a run's session
   * key; the chain enforces it. Any level.
   */
  rate?: { maxProposals: number; ratePeriod: number };
  /**
   * Session scope mask a run's key is narrowed to (e.g. `["propose:intent"]` for
   * a flow that only raises intents, never settles). The vocabulary lives in
   * `@lacrew/core` (`SessionScope`); the orchestrator validates it, since this
   * package stays free of chain dependencies. Applies to the run's key only, not
   * the agent's standing policy.
   */
  scopes?: string[];
};

/**
 * The identity a run executes as. Supplies `agent` defaults to policy-gated
 * steps and forms the caller half of the effective authority: a flow may never
 * exceed either the principal's own policy stack or its scope's ceiling.
 */
export type FlowPrincipal = {
  agent: string;
  nodeKind?: "human_root" | "manager_agent" | "worker_agent";
};

/**
 * Verdict-routed edges shared by every step that touches the chain. Unset
 * `onAllow` falls through to the next declared step; unset `onEscalate`/`onDeny`
 * stop the run.
 */
type PolicyGatedStep = {
  onAllow?: string | null;
  onEscalate?: string | null;
  onDeny?: string | null;
};

type FlowStepBase = {
  /** Unique (per flow) kebab-ish identifier; referenced by edges. */
  id: string;
  /** Display label for UIs; falls back to the id. */
  label?: string;
  /** Free-form note shown in builders; never sent to models. */
  note?: string;
  /**
   * Declares that running this step twice is the same as running it once.
   *
   * Only consulted for side-effecting steps, and only after a crash: a run
   * whose write attempt never finalized is reconciled by re-entering the step
   * when it says this, and failed closed when it does not (F2.26). Untrue here
   * is a double spend, so it stays opt-in and off by default — the operator is
   * asserting something about the far side of the call, which is a claim this
   * package cannot check.
   */
  idempotent?: boolean;
  /**
   * Canvas presentation (visual builder only; ignored by runFlow / validate / codegen).
   * `edgeLabels` offsets mid-edge pills; `refs` are n8n-style extra data inputs
   * (source step ids keyed by handle id) that do not affect control-flow edges.
   */
  ui?: {
    x: number;
    y: number;
    edgeLabels?: Record<string, { x?: number; y?: number }>;
    refs?: Record<string, string>;
  };
};

/**
 * LLM completion via the orchestrator's ModelProvider.
 * `system` / `prompt` support `{{input}}`, `{{steps.<id>.text}}`,
 * `{{steps.<id>.json}}` and `{{steps.<id>.verdict}}` interpolation.
 */
export type ModelStep = FlowStepBase & {
  kind: "model";
  system?: string;
  prompt: string;
  /** Provider-specific model override (optional). */
  model?: string;
  /** Next step id; null = stop; omitted = fall through to the next declared step. */
  next?: string | null;
};

/** LaCrew MCP tool call (e.g. lacrew_get_org_tree). String args are interpolated. */
export type ToolStep = FlowStepBase & {
  kind: "tool";
  tool: string;
  args?: Record<string, unknown>;
  next?: string | null;
};

/**
 * Policy-gated onchain spend: proposes an intent and branches on the verdict.
 * Defaults for `agent`/`target` are filled by the executing backend (the
 * orchestrator uses its crew worker + configured spend target).
 */
export type GateStep = FlowStepBase &
  PolicyGatedStep & {
    kind: "gate";
    agent?: string;
    target?: string;
    /** uint256 decimal string (USDC 6dp in the demo org); interpolated. */
    value: string;
  };

/** Conditional edge on a prior output (string comparison semantics). */
export type BranchStep = FlowStepBase & {
  kind: "branch";
  when: {
    /** Interpolated expression, e.g. "{{steps.triage.text}}". */
    source: string;
    op: "contains" | "equals" | "gt" | "lt" | "exists";
    value?: string;
  };
  onTrue?: string | null;
  onFalse?: string | null;
};

/**
 * Multi-way branch: compare an interpolated source to each case value
 * (trim + case-insensitive equals). First match wins; else `onDefault`.
 * No array fall-through — unset edges stop.
 */
export type SwitchStep = FlowStepBase & {
  kind: "switch";
  when: {
    /** Interpolated expression, e.g. "{{steps.triage.text}}". */
    source: string;
  };
  cases: Array<{
    /** Literal compared to the resolved source. */
    value: string;
    next?: string | null;
  }>;
  onDefault?: string | null;
};

/**
 * Delegate to another agent: hand it a prompt, or run a flow the target agent
 * is scoped to. The delegate runs under its own policy stack, so a flow cannot
 * launder authority by invoking a more privileged agent.
 */
export type AgentStep = FlowStepBase & {
  kind: "agent";
  action: "invoke";
  /** Agent address to delegate to; interpolated. */
  agent: string;
  /** Prompt handed to the delegate; interpolated. Omit when running `flowId`. */
  prompt?: string;
  /** Flow to run as the delegate instead of a free-form prompt. */
  flowId?: string;
  next?: string | null;
};

export type OrgAction =
  | "hire"
  | "fire"
  | "reparent"
  | "activate"
  | "deactivate"
  | "set-cap"
  | "set-whitelist"
  | "set-policy";

/**
 * Change the org chart or an agent's properties. Policy-checked first: ALLOW
 * writes onchain as the running principal, ESCALATE raises a governance
 * proposal (`proposalId` lands in the step output), DENY stops.
 */
export type OrgStep = FlowStepBase &
  PolicyGatedStep & {
    kind: "org";
    action: OrgAction;
    /** Node the action applies to; interpolated. Unused by "hire", which mints one. */
    node?: string;
    /** Display name for the node "hire" creates. */
    label?: string;
    /** New parent for "reparent" and "hire". */
    parent?: string;
    nodeKind?: "manager_agent" | "worker_agent";
    /** uint256 decimal string for "set-cap"; interpolated. */
    cap?: string;
    /** Target address for "set-whitelist" / policy module for "set-policy". */
    target?: string;
    /** Whitelist toggle for "set-whitelist". */
    allowed?: boolean;
  };

export type BudgetAction = "set-grant" | "stream-allowance" | "run-epoch";

/**
 * Move allowances: raise a node's per-epoch grant, stream one now, or run the
 * next epoch. Same verdict routing as `org` — ALLOW writes, ESCALATE proposes.
 */
export type BudgetStep = FlowStepBase &
  PolicyGatedStep & {
    kind: "budget";
    action: BudgetAction;
    /** Node receiving the budget; interpolated. Unused by "run-epoch". */
    node?: string;
    /** uint256 decimal string; interpolated. */
    amount?: string;
  };

export type GovernanceAction = "propose" | "vote" | "veto" | "execute";

/**
 * Act on the GovernanceModule directly: cast a vote, exercise a veto, execute a
 * ripe proposal, or raise a generic (tier, target, data) proposal.
 */
export type GovernanceStep = FlowStepBase & {
  kind: "governance";
  action: GovernanceAction;
  /** Proposal id for vote/veto/execute; interpolated. */
  proposalId?: string;
  /** Vote direction for "vote". */
  support?: boolean;
  /** Generic proposal payload for "propose". */
  tier?: "low" | "high";
  target?: string;
  data?: string;
  next?: string | null;
};

/**
 * Suspend the run here until something outside it says to continue.
 *
 * The pause is declared by the flow rather than discovered by a backend, which
 * is what a human gate or an external event needs: a step that says "a person
 * signs off before the rest of this runs" belongs in the definition an operator
 * reads, not in the failure mode of a connector call. Resuming re-enters the
 * step and falls through — the wait is over, so the step's work is to continue.
 */
export type WaitStep = FlowStepBase & {
  kind: "wait";
  /** Stable pause code recorded on the run; defaults to "awaiting_human". */
  reason?: FlowPauseReason;
  /** Names the thing that will release it (an ask id, a delivery key); interpolated. */
  token?: string;
  /** The one line a human reads in a stalled-run list; interpolated. */
  detail?: string;
  next?: string | null;
};

export type FlowStep =
  | ModelStep
  | ToolStep
  | GateStep
  | BranchStep
  | SwitchStep
  | AgentStep
  | OrgStep
  | BudgetStep
  | GovernanceStep
  | WaitStep;
export type FlowStepKind = FlowStep["kind"];

export type FlowTrigger = "manual" | "epoch" | "cron" | "webhook";

/**
 * Why a run started — wider than what a definition may declare.
 *
 * A flow cannot declare `trigger: "heartbeat"`: a crew heartbeat (F2.21) runs
 * whatever its checklist names, whatever that flow's own trigger says, and a
 * declaration would suggest the flow had opted into something. The *run* still
 * has to say so, or a swept heartbeat run is indistinguishable from a manual
 * one in the trail — which is the one distinction an operator asking "did I do
 * that, or did the crew?" is trying to make.
 */
export type FlowRunTrigger = FlowTrigger | "heartbeat";

export type FlowDefinition = {
  id: string;
  name: string;
  description?: string;
  /**
   * When the flow runs: "manual" (default) via UI/SDK/CLI, or "epoch" —
   * automatically on every payroll epoch (the orchestrator's queue fires it
   * after allowances stream, turning the pipeline into an automation).
   *
   * "webhook" declares the flow externally startable: a signed delivery to the
   * orchestrator's hook surface enqueues a run. The trigger record (id, secret,
   * principal, input mapping) lives in the orchestrator, never in the
   * definition — definitions are listed, exported, and shared through the
   * marketplace, and a secret in one would leak with every copy. The
   * declaration still has to be here, so a flow cannot be made remotely
   * startable without its own definition saying so.
   */
  trigger?: FlowTrigger;
  /** 5-field UTC cron expression; required when trigger is "cron". */
  schedule?: string;
  /**
   * Who the flow is published to, and the policy ceiling its runs are capped at.
   * Defaults to org-wide when omitted.
   */
  scope?: FlowScope;
  /** Entry step id; defaults to the first declared step. */
  entry?: string;
  steps: FlowStep[];
  /** Attribution when installed from a template / marketplace listing. */
  source?: { templateId?: string; author?: string };
};

/**
 * Execution surface a flow runs against. The orchestrator binds this to its
 * ModelProvider + live MCP backend; `createMockFlowBackend()` is the detached
 * fallback for tests and offline demos.
 */
export interface FlowBackend {
  complete(input: {
    system?: string;
    prompt: string;
    model?: string;
  }): Promise<{ text: string; model?: string; mocked?: boolean }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export type FlowStepTrace = {
  stepId: string;
  kind: FlowStepKind;
  label?: string;
  status: "ok" | "error" | "waiting";
  /** Model: { text }. Tool: raw result. Gate: { verdict, intentId?, txHash? }. Branch: { result }. */
  output?: unknown;
  /** One-line human summary for run UIs. */
  summary?: string;
  verdict?: Verdict;
  next: string | null;
  error?: string;
  ms: number;
};

/**
 * The vocabulary of pause codes this package produces.
 *
 * `connector_ask` is an ask-mode write waiting on a human (F2.24);
 * `awaiting_human` and `awaiting_webhook` are declared by a `wait` step;
 * `operator` is a person pausing a run that was mid-flight. A backend may still
 * suspend with a reason of its own — `FlowWaiting.reason` stays a string, since
 * an integration knows things this package does not.
 */
export type FlowPauseReason =
  | "connector_ask"
  | "awaiting_human"
  | "awaiting_webhook"
  | "operator";

/**
 * Why a run stopped short of finishing, and what it is waiting for.
 *
 * `reason` is a stable code (`connector_ask`), `token` names the thing that
 * will release it (an ask id), and `detail` is the one line a human reads in a
 * run list. A waiting run is not a failed run and must not be rendered as one:
 * nothing went wrong, and something is expected to happen next.
 */
export type FlowWaiting = {
  stepId: string;
  reason: FlowPauseReason | (string & {});
  token?: string;
  detail?: string;
};

/**
 * Everything needed to pick a run back up where it stopped.
 *
 * Plain JSON on purpose — it is persisted next to the thing being waited on and
 * read back by a different process than the one that produced it. Carrying the
 * finished step traces means the resumed run reports as one run, rather than as
 * a stub that starts mid-flow with no record of how it got there.
 */
export type FlowResumeState = {
  /** The step to re-enter. It re-executes from the start, not from mid-step. */
  stepId: string;
  /** Outputs of every step that already ran, keyed by step id. */
  outputs: Record<string, { text?: string; json?: string; verdict?: string }>;
  /** Traces of the steps that already ran, in execution order. */
  steps: FlowStepTrace[];
  input?: string;
  startedAt?: string;
};

/**
 * Terminal unless it says otherwise: `waiting` is the paused state (parked and
 * resumable), `cancelled` is an operator ending a run for good. A cancelled run
 * never resumes — that is the whole point of the status, and the surface that
 * owns run state is what enforces it.
 */
export type FlowRunStatus =
  | "completed"
  | "error"
  | "max_steps"
  | "waiting"
  | "cancelled";

/**
 * What a caller may do to a run between two steps.
 *
 * Consulted by `runFlow` before each step because that is the only place a
 * decision can be honoured without abandoning work already in flight: a pause
 * that landed mid-write would either lose the call's result or duplicate it.
 */
export type FlowControl = "continue" | "pause" | "cancel";

/**
 * The durable record of a step that finished (F2.26).
 *
 * Written *before* the next step starts, so the process that dies between two
 * steps leaves behind exactly one honest cursor: everything up to `stepId`
 * happened, `nextStepId` did not. `state` is what a resume hands back to
 * `runFlow`; it is absent on the checkpoint of a step the run ended on, since
 * there is nothing left to re-enter.
 *
 * Checkpoints are operational state, never an authority surface. Resuming from
 * one re-runs the same policy checks against the same principal — it does not
 * carry a verdict forward, and it cannot admit anything policy would refuse.
 */
export type FlowCheckpoint = {
  runId: string;
  flowId: string;
  /** Monotonic within a run: 1 for the first completed step. */
  seq: number;
  /** The step whose completion this records. */
  stepId: string;
  /** Cursor — the step a resume enters, or null when the run went no further. */
  nextStepId: string | null;
  status: "running" | "paused";
  /** Set when `status` is "paused": what the run is parked on. */
  pause?: FlowWaiting;
  state?: FlowResumeState;
  at: string;
};

/**
 * An in-flight side-effecting step: opened before the call goes out, settled
 * once it returned.
 *
 * A crash between the two leaves the attempt open, which is the one state a
 * resume must not treat as "not started yet". `key` is stable per (run, step,
 * seq), so a redelivered resume of the same cursor reconciles against the same
 * attempt rather than opening a second one.
 */
export type FlowAttempt = {
  runId: string;
  flowId: string;
  stepId: string;
  kind: FlowStepKind;
  seq: number;
  key: string;
  /** The step's own claim that a repeat is harmless; see `FlowStepBase`. */
  idempotent: boolean;
  startedAt: string;
};

/** How an attempt ended. `paused` means the call never went out. */
export type FlowAttemptOutcome = "ok" | "error" | "paused";

/**
 * Where durability actually lives. The engine stays storage-free: the
 * orchestrator binds this to Postgres (or to memory, for tests), and a run
 * given no sink runs exactly as it did before checkpoints existed.
 *
 * `record` is awaited, and a throw fails the run. Continuing past a checkpoint
 * that was not written would leave a side-effecting step with no durable record
 * that it ran — the precise state resume is not allowed to guess about.
 */
export interface FlowCheckpointSink {
  record(checkpoint: FlowCheckpoint): Promise<void>;
  /** Open an attempt on a side-effecting step, before the call goes out. */
  begin?(attempt: FlowAttempt): Promise<void>;
  /** Close it once the call returned, threw, or suspended. */
  settle?(attempt: FlowAttempt, outcome: FlowAttemptOutcome): Promise<void>;
}

export type FlowRunResult = {
  runId: string;
  flowId: string;
  flowName?: string;
  status: FlowRunStatus;
  /** What fired the run ("manual" unless something scheduled it). */
  trigger?: FlowRunTrigger;
  /** Identity the run executed as; absent for detached mock runs. */
  principal?: FlowPrincipal;
  startedAt: string;
  finishedAt: string;
  input?: string;
  steps: FlowStepTrace[];
  mocked?: boolean;
  /** Set when `status` is "waiting": what the run stopped on. */
  waiting?: FlowWaiting;
  /** Set when `status` is "waiting": hand this back to `runFlow` to continue. */
  resume?: FlowResumeState;
};

/** Prebuilt flow shipped with LaCrew; doubles as the marketplace catalog entry. */
export type FlowTemplate = {
  id: string;
  name: string;
  description: string;
  category: "treasury" | "escalation" | "content" | "trading" | "dev" | "governance";
  author: string;
  definition: FlowDefinition;
};
