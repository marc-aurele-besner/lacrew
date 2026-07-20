import type {
  FlowBackend,
  FlowDefinition,
  FlowPrincipal,
  FlowRunResult,
  FlowStep,
  FlowStepTrace,
  Verdict,
} from "./types.js";
import { fallThrough, validateFlow } from "./validate.js";

/** Cycle validation already rejects loops; this bounds pathological definitions. */
const MAX_STEPS = 64;

type StepOutputs = Record<string, { text?: string; json?: string; verdict?: string }>;

/**
 * Interpolate `{{input}}`, `{{steps.<id>.text|json|verdict}}` into a string.
 * Unknown references render as empty strings so prompts stay usable mid-build.
 */
export function interpolate(
  template: string,
  ctx: { input?: string; steps: StepOutputs },
): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
    if (path === "input") return ctx.input ?? "";
    const m = /^steps\.([\w-]+)\.(text|json|verdict)$/.exec(path);
    if (m?.[1] && m[2]) return ctx.steps[m[1]]?.[m[2] as "text" | "json" | "verdict"] ?? "";
    return "";
  });
}

function interpolateArgs(
  args: Record<string, unknown> | undefined,
  ctx: { input?: string; steps: StepOutputs },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = typeof v === "string" ? interpolate(v, ctx) : v;
  }
  return out;
}

function normalizeVerdict(raw: unknown): Verdict | undefined {
  const s = String(raw ?? "").toUpperCase();
  return s === "ALLOW" || s === "ESCALATE" || s === "DENY" ? s : undefined;
}

function truncate(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Shared edge resolution for every policy-gated kind (gate / org / budget). */
function routeVerdict(
  def: FlowDefinition,
  step: {
    id: string;
    onAllow?: string | null;
    onEscalate?: string | null;
    onDeny?: string | null;
  },
  verdict: Verdict,
): string | null {
  const edge =
    verdict === "ALLOW"
      ? step.onAllow
      : verdict === "ESCALATE"
        ? step.onEscalate
        : step.onDeny;
  // ALLOW falls through by default; ESCALATE/DENY stop unless routed.
  return edge !== undefined ? edge : verdict === "ALLOW" ? fallThrough(def, step.id) : null;
}

/**
 * Record a policy-gated tool result on the trace. An unreadable verdict becomes
 * ESCALATE so an unrecognised backend response can never read as approval.
 */
function recordVerdict(
  trace: FlowStepTrace,
  outputs: StepOutputs,
  stepId: string,
  result: Record<string, unknown> | undefined,
): Verdict {
  const verdict = normalizeVerdict(result?.verdict) ?? "ESCALATE";
  outputs[stepId] = {
    text: verdict,
    json: JSON.stringify(result ?? {}),
    verdict,
  };
  trace.output = result;
  trace.verdict = verdict;
  return verdict;
}

/** "wrote onchain (0x…)" / "raised proposal 7" / "denied by policy". */
function verdictSummary(what: string, verdict: Verdict, result?: Record<string, unknown>): string {
  if (verdict === "ALLOW") {
    return `${what} applied${result?.txHash ? ` (${result.txHash})` : ""}`;
  }
  if (verdict === "ESCALATE") {
    return `${what} raised for approval${result?.proposalId ? ` (proposal ${result.proposalId})` : result?.intentId ? ` (intent ${result.intentId})` : ""}`;
  }
  return `${what} denied by policy`;
}

export type RunFlowOptions = {
  input?: string;
  runId?: string;
  /** What fired the run; recorded on the result (default "manual"). */
  trigger?: FlowDefinition["trigger"];
  /**
   * Identity the run executes as. Recorded on the result and supplied to the
   * backend as the `agent` default for policy-gated steps.
   */
  principal?: FlowPrincipal;
  /** Marks the whole run as mocked in the result (set by mock backends). */
  mocked?: boolean;
  /** Observer invoked after each step completes — live progress for CLIs/UIs. */
  onStep?: (trace: FlowStepTrace) => void;
};

/**
 * Execute a flow definition against a backend, producing a full step trace.
 * Never throws for step failures — the trace carries the error and the run
 * ends with status "error".
 */
export async function runFlow(
  def: FlowDefinition,
  backend: FlowBackend,
  opts: RunFlowOptions = {},
): Promise<FlowRunResult> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const steps: FlowStepTrace[] = [];
  const outputs: StepOutputs = {};
  const ctx = { input: opts.input, steps: outputs };

  const invalid = validateFlow(def);
  if (!invalid.ok) {
    return {
      runId,
      flowId: def.id,
      flowName: def.name,
      status: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      input: opts.input,
      steps: [
        {
          stepId: "validate",
          kind: "branch",
          status: "error",
          error: invalid.errors.join("; "),
          next: null,
          ms: 0,
        },
      ],
      mocked: opts.mocked,
    };
  }

  const byId = new Map(def.steps.map((s) => [s.id, s]));
  let current: string | null = def.entry ?? def.steps[0]?.id ?? null;
  let status: FlowRunResult["status"] = "completed";

  while (current) {
    if (steps.length >= MAX_STEPS) {
      status = "max_steps";
      break;
    }
    const step = byId.get(current) as FlowStep;
    const t0 = Date.now();
    const trace: FlowStepTrace = {
      stepId: step.id,
      kind: step.kind,
      label: step.label,
      status: "ok",
      next: null,
      ms: 0,
    };

    try {
      switch (step.kind) {
        case "model": {
          const result = await backend.complete({
            system: step.system ? interpolate(step.system, ctx) : undefined,
            prompt: interpolate(step.prompt, ctx),
            model: step.model,
          });
          outputs[step.id] = { text: result.text, json: JSON.stringify(result) };
          trace.output = { text: result.text, model: result.model, mocked: result.mocked };
          trace.summary = truncate(result.text);
          trace.next = step.next === undefined ? fallThrough(def, step.id) : step.next;
          break;
        }
        case "tool": {
          const result = await backend.callTool(step.tool, interpolateArgs(step.args, ctx));
          const json = JSON.stringify(result, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          );
          outputs[step.id] = { text: json, json };
          trace.output = result;
          trace.summary = `${step.tool} → ${truncate(json ?? "null", 120)}`;
          trace.next = step.next === undefined ? fallThrough(def, step.id) : step.next;
          break;
        }
        case "gate": {
          const args: Record<string, unknown> = {
            value: interpolate(step.value, ctx),
          };
          if (step.agent) args.agent = interpolate(step.agent, ctx);
          else if (opts.principal) args.agent = opts.principal.agent;
          if (step.target) args.target = interpolate(step.target, ctx);
          const result = (await backend.callTool("lacrew_propose_intent", args)) as
            | Record<string, unknown>
            | undefined;
          const verdict = recordVerdict(trace, outputs, step.id, result);
          trace.summary =
            verdict === "ALLOW"
              ? `spend allowed under policy${result?.txHash ? ` (${result.txHash})` : ""}`
              : verdict === "ESCALATE"
                ? `escalated up the reporting line${result?.intentId ? ` (intent ${result.intentId})` : ""}`
                : "denied by policy";
          trace.next = routeVerdict(def, step, verdict);
          break;
        }
        case "branch": {
          const source = interpolate(step.when.source, ctx);
          const expected = step.when.value ?? "";
          let result: boolean;
          switch (step.when.op) {
            case "contains":
              result = source.toLowerCase().includes(expected.toLowerCase());
              break;
            case "equals":
              result = source.trim().toLowerCase() === expected.trim().toLowerCase();
              break;
            case "gt":
              result = Number(source) > Number(expected);
              break;
            case "lt":
              result = Number(source) < Number(expected);
              break;
            case "exists":
              result = source.trim().length > 0;
              break;
          }
          outputs[step.id] = { text: String(result), json: JSON.stringify({ result, source }) };
          trace.output = { result, source: truncate(source, 120) };
          trace.summary = `${step.when.op} → ${result}`;
          trace.next =
            result
              ? step.onTrue === undefined
                ? fallThrough(def, step.id)
                : step.onTrue
              : (step.onFalse ?? null);
          break;
        }
        case "switch": {
          const source = interpolate(step.when.source, ctx).trim().toLowerCase();
          let matched: { value: string; next?: string | null } | undefined;
          for (const c of step.cases) {
            if (c.value.trim().toLowerCase() === source) {
              matched = c;
              break;
            }
          }
          const next = matched ? (matched.next ?? null) : (step.onDefault ?? null);
          outputs[step.id] = {
            text: matched ? matched.value : "default",
            json: JSON.stringify({ source, matched: matched?.value ?? null }),
          };
          trace.output = { source: truncate(source, 120), matched: matched?.value ?? null };
          trace.summary = matched
            ? `case "${truncate(matched.value, 40)}" → ${next ?? "stop"}`
            : `default → ${next ?? "stop"}`;
          trace.next = next;
          break;
        }
        case "agent": {
          const agent = interpolate(step.agent, ctx);
          const result = (await backend.callTool("lacrew_invoke_agent", {
            agent,
            ...(step.prompt ? { prompt: interpolate(step.prompt, ctx) } : {}),
            ...(step.flowId ? { flowId: step.flowId } : {}),
          })) as Record<string, unknown> | undefined;
          const json = JSON.stringify(result ?? {}, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          );
          outputs[step.id] = { text: String(result?.text ?? json), json };
          trace.output = result;
          trace.summary = `delegated to ${truncate(agent, 42)} → ${truncate(String(result?.text ?? json), 120)}`;
          trace.next = step.next === undefined ? fallThrough(def, step.id) : step.next;
          break;
        }
        case "org": {
          const result = (await backend.callTool("lacrew_org_action", {
            action: step.action,
            node: interpolate(step.node, ctx),
            ...(step.parent ? { parent: interpolate(step.parent, ctx) } : {}),
            ...(step.nodeKind ? { nodeKind: step.nodeKind } : {}),
            ...(step.cap ? { cap: interpolate(step.cap, ctx) } : {}),
            ...(step.target ? { target: interpolate(step.target, ctx) } : {}),
            ...(step.allowed === undefined ? {} : { allowed: step.allowed }),
          })) as Record<string, unknown> | undefined;
          const verdict = recordVerdict(trace, outputs, step.id, result);
          trace.summary = verdictSummary(step.action, verdict, result);
          trace.next = routeVerdict(def, step, verdict);
          break;
        }
        case "budget": {
          const result = (await backend.callTool("lacrew_set_budget", {
            action: step.action,
            ...(step.node ? { node: interpolate(step.node, ctx) } : {}),
            ...(step.amount ? { amount: interpolate(step.amount, ctx) } : {}),
          })) as Record<string, unknown> | undefined;
          const verdict = recordVerdict(trace, outputs, step.id, result);
          trace.summary = verdictSummary(step.action, verdict, result);
          trace.next = routeVerdict(def, step, verdict);
          break;
        }
        case "governance": {
          const result = (await backend.callTool("lacrew_governance", {
            action: step.action,
            ...(step.proposalId ? { proposalId: interpolate(step.proposalId, ctx) } : {}),
            ...(step.support === undefined ? {} : { support: step.support }),
            ...(step.tier ? { tier: step.tier } : {}),
            ...(step.target ? { target: interpolate(step.target, ctx) } : {}),
            ...(step.data ? { data: interpolate(step.data, ctx) } : {}),
          })) as Record<string, unknown> | undefined;
          const json = JSON.stringify(result ?? {}, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          );
          outputs[step.id] = { text: String(result?.proposalId ?? json), json };
          trace.output = result;
          trace.summary = `${step.action}${result?.proposalId ? ` proposal ${result.proposalId}` : ""}${result?.txHash ? ` (${result.txHash})` : ""}`;
          trace.next = step.next === undefined ? fallThrough(def, step.id) : step.next;
          break;
        }
      }
    } catch (err) {
      trace.status = "error";
      trace.error = err instanceof Error ? err.message : String(err);
      trace.next = null;
      status = "error";
    }

    trace.ms = Date.now() - t0;
    steps.push(trace);
    try {
      opts.onStep?.(trace);
    } catch {
      /* observer errors never break the run */
    }
    current = trace.next;
    if (status === "error") break;
  }

  return {
    runId,
    flowId: def.id,
    flowName: def.name,
    status,
    trigger: opts.trigger ?? "manual",
    principal: opts.principal,
    startedAt,
    finishedAt: new Date().toISOString(),
    input: opts.input,
    steps,
    mocked: opts.mocked,
  };
}

/**
 * Detached backend for tests and offline demos (Mocked): canned model text,
 * canned tool payloads, and a gate that escalates above 100 USDC (6dp).
 */
export function createMockFlowBackend(): FlowBackend {
  return {
    async complete({ prompt, system, model }) {
      const seed = truncate(prompt.replace(/\s+/g, " ").trim(), 80);
      return {
        text: `[mock ${model ?? "model"}] ${system ? "(system set) " : ""}${seed}`,
        model: model ?? "mock",
        mocked: true,
      };
    },
    async callTool(name, args) {
      switch (name) {
        case "lacrew_get_org_tree":
          return [
            { account: "0xR00T", kind: "human_root", label: "Root" },
            { account: "0xMGR1", kind: "manager_agent", label: "Manager A" },
            { account: "0xWKR1", kind: "worker_agent", label: "Worker 1" },
          ];
        case "lacrew_list_pending_intents":
          return [
            { intentId: "mock-intent-1", agent: "0xWKR1", value: "150000000", status: "pending" },
          ];
        case "lacrew_propose_intent": {
          const value = BigInt(String(args.value ?? "0"));
          const verdict: Verdict = value > 100_000_000n ? "ESCALATE" : "ALLOW";
          return { intentId: `mock-intent-${value}`, verdict, mocked: true };
        }
        case "lacrew_approve_intent":
          return { intentId: String(args.intentId ?? ""), approved: Boolean(args.approved), mocked: true };
        case "lacrew_check_policy": {
          const value = BigInt(String(args.value ?? "0"));
          return { verdict: value > 100_000_000n ? "ESCALATE" : "ALLOW", mocked: true };
        }
        case "lacrew_invoke_agent":
          return {
            agent: String(args.agent ?? ""),
            text: `[mock delegate ${String(args.agent ?? "")}] ${truncate(String(args.prompt ?? args.flowId ?? ""), 80)}`,
            mocked: true,
          };
        case "lacrew_org_action": {
          // Structural changes are constitutional: the mock always escalates.
          return {
            verdict: "ESCALATE" as Verdict,
            action: String(args.action ?? ""),
            proposalId: `mock-proposal-${String(args.action ?? "")}`,
            mocked: true,
          };
        }
        case "lacrew_set_budget": {
          const amount = BigInt(String(args.amount ?? "0"));
          const verdict: Verdict = amount > 100_000_000n ? "ESCALATE" : "ALLOW";
          return {
            verdict,
            action: String(args.action ?? ""),
            ...(verdict === "ESCALATE"
              ? { proposalId: `mock-proposal-${amount}` }
              : { txHash: `0xmock${amount}` }),
            mocked: true,
          };
        }
        case "lacrew_governance":
          return {
            action: String(args.action ?? ""),
            proposalId: String(args.proposalId ?? "mock-proposal-1"),
            txHash: "0xmockgov",
            mocked: true,
          };
        default:
          throw new Error(`Unknown mock tool: ${name}`);
      }
    },
  };
}
