/**
 * @lacrew/flows — declarative agent logic flows (pipelines) over LaCrew.
 *
 * A flow is a small DAG of steps (model calls, LaCrew MCP tools, policy-gated
 * spends, branches) that the orchestrator executes against its live runtime.
 * The same definition powers the visual builder (UX-first) and the code-first
 * SDK path: definitions are plain JSON, buildable with the fluent `flow()` API
 * and renderable back to TypeScript via `flowToCode()`.
 *
 * Flows never hold keys and never touch the treasury: every onchain effect
 * goes through `lacrew_propose_intent`, so policy stacks and escalation apply
 * exactly as they do for any other agent action.
 */

export type Verdict = "ALLOW" | "ESCALATE" | "DENY";

type FlowStepBase = {
  /** Unique (per flow) kebab-ish identifier; referenced by edges. */
  id: string;
  /** Display label for UIs; falls back to the id. */
  label?: string;
  /** Free-form note shown in builders; never sent to models. */
  note?: string;
  /** Canvas position (visual builder only; ignored by runFlow / validate / codegen). */
  ui?: { x: number; y: number };
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
export type GateStep = FlowStepBase & {
  kind: "gate";
  agent?: string;
  target?: string;
  /** uint256 decimal string (USDC 6dp in the demo org); interpolated. */
  value: string;
  /** Edge per verdict; null = stop (default for ESCALATE/DENY). */
  onAllow?: string | null;
  onEscalate?: string | null;
  onDeny?: string | null;
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

export type FlowStep = ModelStep | ToolStep | GateStep | BranchStep;
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
  category: "treasury" | "escalation" | "content" | "trading";
  author: string;
  definition: FlowDefinition;
};
