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

export type FlowStep =
  | ModelStep
  | ToolStep
  | GateStep
  | BranchStep
  | SwitchStep
  | AgentStep
  | OrgStep
  | BudgetStep
  | GovernanceStep;
export type FlowStepKind = FlowStep["kind"];

export type FlowTrigger = "manual" | "epoch" | "cron";

export type FlowDefinition = {
  id: string;
  name: string;
  description?: string;
  /**
   * When the flow runs: "manual" (default) via UI/SDK/CLI, or "epoch" —
   * automatically on every payroll epoch (the orchestrator's queue fires it
   * after allowances stream, turning the pipeline into an automation).
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
  status: "ok" | "error";
  /** Model: { text }. Tool: raw result. Gate: { verdict, intentId?, txHash? }. Branch: { result }. */
  output?: unknown;
  /** One-line human summary for run UIs. */
  summary?: string;
  verdict?: Verdict;
  next: string | null;
  error?: string;
  ms: number;
};

export type FlowRunStatus = "completed" | "error" | "max_steps";

export type FlowRunResult = {
  runId: string;
  flowId: string;
  flowName?: string;
  status: FlowRunStatus;
  /** What fired the run ("manual" unless the epoch queue triggered it). */
  trigger?: FlowTrigger;
  /** Identity the run executed as; absent for detached mock runs. */
  principal?: FlowPrincipal;
  startedAt: string;
  finishedAt: string;
  input?: string;
  steps: FlowStepTrace[];
  mocked?: boolean;
};

/** Prebuilt flow shipped with LaCrew; doubles as the marketplace catalog entry. */
export type FlowTemplate = {
  id: string;
  name: string;
  description: string;
  category: "treasury" | "escalation" | "content" | "trading" | "governance";
  author: string;
  definition: FlowDefinition;
};
