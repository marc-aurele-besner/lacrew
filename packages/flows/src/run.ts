import type {
  FlowAttempt,
  FlowAttemptOutcome,
  FlowBackend,
  FlowCheckpoint,
  FlowCheckpointSink,
  FlowControl,
  FlowDefinition,
  FlowPrincipal,
  FlowResumeState,
  FlowRunResult,
  FlowRunTrigger,
  FlowStep,
  FlowStepTrace,
  Verdict,
} from "./types.js";
import { fallThrough, validateFlow } from "./validate.js";

/** Cycle validation already rejects loops; this bounds pathological definitions. */
const MAX_STEPS = 64;

/**
 * LaCrew MCP tools that only read. Everything else — a policy-gated write, a
 * message posted into a thread, any connector route — is assumed to change
 * something a second call would change again.
 */
const READ_ONLY_TOOLS = new Set([
  "lacrew_get_org_tree",
  "lacrew_list_pending_intents",
  "lacrew_check_policy",
  "lacrew_read_thread",
]);

/**
 * Whether re-entering this step could do the same work twice.
 *
 * The question a resume has to answer, and it is answered pessimistically for
 * anything this package cannot see the far side of: a `<connector>.<route>`
 * call is the operator's own surface, and its method is not in the definition.
 * Being wrong in the cautious direction costs an attempt record; being wrong in
 * the other direction is a second payment.
 */
export function stepHasSideEffects(step: FlowStep): boolean {
  switch (step.kind) {
    case "gate":
    case "org":
    case "budget":
    case "governance":
    case "agent":
      return true;
    case "tool":
      return !READ_ONLY_TOOLS.has(step.tool);
    case "human":
      // Asking is not a side effect here: the backend keys a gate by the run
      // and the step, so re-entering finds the question it already posted
      // rather than posting a second one. An attempt record would instead fail
      // an untouched run closed after a crash that never called anything.
      return false;
    default:
      return false;
  }
}

type StepOutputs = Record<string, { text?: string; json?: string; verdict?: string }>;

/**
 * Thrown by a backend to stop a run without failing it.
 *
 * Some steps cannot finish now and are not wrong: a connector write in `ask`
 * mode is waiting on a human, and the honest thing for the run to do is stop
 * and say so. It cannot block instead — a run that sat on the event loop for
 * the hours a person takes to answer would tie a funded run's lifetime to a
 * process that will be redeployed before then.
 *
 * The marker property, not the prototype, is what `isFlowWaiting` tests. Two
 * copies of this package in one process (the cloud links `@lacrew/flows` from
 * disk) would otherwise produce an error that fails `instanceof` against the
 * class the engine imported, and a wait would be recorded as a crash.
 */
export class FlowWaitingError extends Error {
  readonly __flowWaiting = true as const;
  readonly reason: string;
  readonly token?: string;
  readonly detail?: string;

  constructor(input: { reason: string; token?: string; detail?: string }) {
    super(`flow_waiting:${input.reason}${input.token ? `:${input.token}` : ""}`);
    this.name = "FlowWaitingError";
    this.reason = input.reason;
    if (input.token) this.token = input.token;
    if (input.detail) this.detail = input.detail;
  }
}

export function isFlowWaiting(
  err: unknown,
): err is { reason: string; token?: string; detail?: string; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { __flowWaiting?: unknown }).__flowWaiting === true &&
    typeof (err as { reason?: unknown }).reason === "string"
  );
}

/**
 * Interpolate `{{input}}`, `{{input.<key>}}`, and
 * `{{steps.<id>.text|json|verdict}}` into a string. Unknown references render
 * as empty strings so prompts stay usable mid-build.
 *
 * `{{input.<key>}}` reads a field of a JSON run input, which is what a tool
 * call needs: a route wants an owner, a repo, and a number as separate args,
 * and the alternative — asking a model to re-extract each one from a blob it
 * was already given — is three completions and three chances to be wrong.
 * A non-JSON input yields empty for keyed refs; `{{input}}` still returns it
 * verbatim.
 */
export function interpolate(
  template: string,
  ctx: { input?: string; steps: StepOutputs },
): string {
  let inputFields: Record<string, unknown> | null | undefined;
  const field = (key: string): string => {
    if (inputFields === undefined) {
      try {
        const parsed: unknown = JSON.parse(ctx.input ?? "");
        inputFields = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        inputFields = null;
      }
    }
    const value = inputFields?.[key];
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  };

  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
    if (path === "input") return ctx.input ?? "";
    const keyed = /^input\.([\w-]+)$/.exec(path);
    if (keyed?.[1]) return field(keyed[1]);
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * Describe what the backend actually did, not what the verdict permitted.
 * A constitutional action still becomes a proposal under ALLOW — it just earns
 * the faster tier — so only a bare txHash may be reported as applied.
 */
function verdictSummary(what: string, verdict: Verdict, result?: Record<string, unknown>): string {
  if (verdict === "DENY") return `${what} denied by policy`;
  const tier = verdict === "ALLOW" ? "low tier" : "high tier, timelocked";
  if (result?.proposalId) {
    return `${what} → proposal ${result.proposalId} (${tier})`;
  }
  if (result?.intentId) {
    return `${what} → intent ${result.intentId} awaiting approval`;
  }
  if (result?.txHash) return `${what} applied (${result.txHash})`;
  return `${what} → ${verdict.toLowerCase()}`;
}

export type RunFlowOptions = {
  input?: string;
  runId?: string;
  /** What fired the run; recorded on the result (default "manual"). */
  trigger?: FlowRunTrigger;
  /**
   * Identity the run executes as. Recorded on the result and supplied to the
   * backend as the `agent` default for policy-gated steps.
   */
  principal?: FlowPrincipal;
  /** Marks the whole run as mocked in the result (set by mock backends). */
  mocked?: boolean;
  /** Observer invoked after each step completes — live progress for CLIs/UIs. */
  onStep?: (trace: FlowStepTrace) => void;
  /**
   * Continue a run that stopped with status "waiting", from the state its
   * result carried. The waiting step re-executes from the beginning: whatever
   * suspended it is expected to answer differently now, and re-entering the
   * step is what lets the same code path do the work it deferred.
   */
  resume?: FlowResumeState;
  /**
   * Durable state (F2.26). Given one, every completed step is checkpointed
   * before the next one starts, and every side-effecting step opens an attempt
   * record before its call goes out. Omitted, the run behaves exactly as it did
   * before checkpoints existed — the engine keeps no storage of its own.
   */
  checkpoints?: FlowCheckpointSink;
  /**
   * Asked before each step whether the run may proceed. This is how an operator
   * pauses or cancels a run that is already moving: the decision lands between
   * two steps, never inside one, so nothing is abandoned mid-write.
   */
  control?: (ctx: {
    runId: string;
    /** The step about to run. */
    stepId: string;
    /** Steps completed so far. */
    seq: number;
  }) => Promise<FlowControl> | FlowControl;
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
  // A resumed run keeps the original start time: the wait is part of how long
  // the run took, and restamping it would report an hour-long pause as instant.
  const startedAt = opts.resume?.startedAt ?? new Date().toISOString();
  const runId = opts.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const steps: FlowStepTrace[] = [...(opts.resume?.steps ?? [])];
  const outputs: StepOutputs = { ...(opts.resume?.outputs ?? {}) };
  const input = opts.resume ? (opts.resume.input ?? opts.input) : opts.input;
  const ctx = { input, steps: outputs };

  const invalid = validateFlow(def);
  if (!invalid.ok) {
    return {
      runId,
      flowId: def.id,
      flowName: def.name,
      status: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      input,
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
  let current: string | null = opts.resume?.stepId ?? def.entry ?? def.steps[0]?.id ?? null;
  let status: FlowRunResult["status"] = "completed";
  let waiting: FlowRunResult["waiting"];
  const sink = opts.checkpoints;
  /** Continues the numbering across a resume: a run has one sequence, not one per attempt. */
  let seq = steps.length;
  /**
   * True only while the first step of a resumed run executes. A `wait` step is
   * released by the resume itself; a later one in the same pass is a fresh wait
   * and must park the run again.
   */
  let releasing = Boolean(opts.resume);
  // A step the definition no longer has: the flow was edited while a run of it
  // sat waiting. Failing here beats resuming into whatever step now happens to
  // carry that id, which would run work the operator had already removed.
  if (opts.resume && current && !byId.has(current)) {
    return {
      runId,
      flowId: def.id,
      flowName: def.name,
      status: "error",
      trigger: opts.trigger ?? "manual",
      principal: opts.principal,
      startedAt,
      finishedAt: new Date().toISOString(),
      input,
      steps: [
        ...steps,
        {
          stepId: current,
          kind: "branch",
          status: "error",
          error: `resume_step_missing:${current}`,
          next: null,
          ms: 0,
        },
      ],
      mocked: opts.mocked,
    };
  }

  while (current) {
    if (steps.length >= MAX_STEPS) {
      status = "max_steps";
      break;
    }
    const step = byId.get(current) as FlowStep;

    if (opts.control) {
      let decision: FlowControl = "continue";
      try {
        decision = await opts.control({ runId, stepId: step.id, seq });
      } catch {
        // An unreadable control answer is not a decision. A run that was
        // already authorised to run keeps going: stalling every run on a
        // transient store hiccup would turn a blip into a queue of stalls.
        decision = "continue";
      }
      if (decision === "cancel") {
        status = "cancelled";
        break;
      }
      if (decision === "pause") {
        status = "waiting";
        waiting = {
          stepId: step.id,
          reason: "operator",
          detail: `paused before "${step.label ?? step.id}"`,
        };
        break;
      }
    }

    const t0 = Date.now();
    const trace: FlowStepTrace = {
      stepId: step.id,
      kind: step.kind,
      label: step.label,
      status: "ok",
      next: null,
      ms: 0,
    };

    // Opened before the call, settled after it. A crash in between leaves the
    // attempt open, which is the only state that tells a restarting
    // orchestrator "this write may already have happened".
    const attempt: FlowAttempt | undefined =
      sink && stepHasSideEffects(step)
        ? {
            runId,
            flowId: def.id,
            stepId: step.id,
            kind: step.kind,
            seq: seq + 1,
            key: `${runId}:${step.id}:${seq + 1}`,
            idempotent: step.idempotent === true,
            startedAt: new Date().toISOString(),
          }
        : undefined;
    let opened = false;
    let outcome: FlowAttemptOutcome = "ok";

    try {
      if (attempt) {
        await sink?.begin?.(attempt);
        opened = true;
      }
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
            ...(step.node ? { node: interpolate(step.node, ctx) } : {}),
            ...(step.label ? { label: interpolate(step.label, ctx) } : {}),
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
        case "human": {
          // The backend owns the question, the deadline and who may answer.
          // It either resolves the gate or throws FlowWaitingError to park the
          // run — this step never blocks the event loop waiting on a person.
          const result = (await backend.callTool("lacrew_human_gate", {
            stepId: step.id,
            prompt: interpolate(step.prompt, ctx),
            options: step.options.map((o) => ({ id: o.id, label: o.label ?? o.id })),
            ...(step.label ? { label: step.label } : {}),
            ...(step.assignee ? { assignee: interpolate(step.assignee, ctx) } : {}),
            ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
          })) as Record<string, unknown> | undefined;

          const outcome = String(result?.outcome ?? "");
          if (outcome === "timed_out") {
            // Fail closed. A gate nobody answered has decided nothing, so with
            // no timeout port declared the run stops here rather than falling
            // into whatever step happened to come next.
            if (step.timeoutPort === undefined || step.timeoutPort === null) {
              throw new Error(`human_gate_timeout:${step.id}`);
            }
            outputs[step.id] = {
              text: "timed_out",
              json: JSON.stringify({ outcome, ...(result ?? {}) }),
            };
            trace.output = { outcome: "timed_out", gateId: result?.gateId };
            trace.summary = "nobody answered — taking the timeout port";
            trace.next = step.timeoutPort;
            break;
          }

          const optionId = String(result?.optionId ?? "").trim().toLowerCase();
          const chosen = step.options.find((o) => o.id.trim().toLowerCase() === optionId);
          if (outcome !== "answered" || !chosen) {
            // An answer this step never offered routes nowhere. Guessing at the
            // nearest option would let a typo pick the branch that writes.
            throw new Error(
              `human_gate_unrecognized:${step.id}:${optionId || outcome || "empty"}`,
            );
          }
          outputs[step.id] = {
            text: chosen.id,
            json: JSON.stringify({
              outcome: "answered",
              optionId: chosen.id,
              ...(result?.answeredBy ? { answeredBy: result.answeredBy } : {}),
            }),
          };
          trace.output = {
            outcome: "answered",
            optionId: chosen.id,
            ...(result?.answeredBy ? { answeredBy: result.answeredBy } : {}),
            ...(result?.gateId ? { gateId: result.gateId } : {}),
          };
          trace.summary = `"${chosen.label ?? chosen.id}" chosen${
            result?.answeredBy ? ` by ${String(result.answeredBy)}` : ""
          }`;
          trace.next = chosen.port ?? null;
          break;
        }
        case "wait": {
          if (!releasing) {
            throw new FlowWaitingError({
              reason: step.reason ?? "awaiting_human",
              ...(step.token ? { token: interpolate(step.token, ctx) } : {}),
              detail: step.detail
                ? interpolate(step.detail, ctx)
                : `waiting at "${step.label ?? step.id}"`,
            });
          }
          outputs[step.id] = { text: "released", json: JSON.stringify({ released: true }) };
          trace.output = { released: true };
          trace.summary = "released — the wait is over";
          trace.next = step.next === undefined ? fallThrough(def, step.id) : step.next;
          break;
        }
      }
    } catch (err) {
      if (isFlowWaiting(err)) {
        outcome = "paused";
        trace.status = "waiting";
        trace.summary = err.detail ?? err.message;
        trace.next = null;
        status = "waiting";
        waiting = {
          stepId: step.id,
          reason: err.reason,
          ...(err.token ? { token: err.token } : {}),
          ...(err.detail ? { detail: err.detail } : {}),
        };
      } else {
        outcome = "error";
        trace.status = "error";
        trace.error = err instanceof Error ? err.message : String(err);
        trace.next = null;
        status = "error";
      }
    }

    if (attempt && opened) {
      try {
        await sink?.settle?.(attempt, outcome);
      } catch (err) {
        // The call may already have gone out and we can no longer say so
        // durably. Reporting the run as fine would hand a resume the same
        // write to redo, so the run fails here and is reconciled by hand.
        trace.status = "error";
        trace.error = `attempt_settle_failed:${step.id}: ${errText(err)}`;
        trace.next = null;
        status = "error";
      }
    }

    trace.ms = Date.now() - t0;
    steps.push(trace);
    seq += 1;
    releasing = false;
    try {
      opts.onStep?.(trace);
    } catch {
      /* observer errors never break the run */
    }
    current = trace.next;

    if (sink) {
      const paused = status === "waiting";
      // A paused run re-enters the step it paused on; a running one moves to
      // the cursor the step routed to.
      const next = paused ? (waiting?.stepId ?? null) : current;
      const checkpoint: FlowCheckpoint = {
        runId,
        flowId: def.id,
        seq,
        stepId: step.id,
        nextStepId: next,
        status: paused ? "paused" : "running",
        ...(paused && waiting ? { pause: waiting } : {}),
        ...(next
          ? {
              state: {
                stepId: next,
                // Snapshots: the live objects keep changing after this returns.
                outputs: { ...outputs },
                steps: [...steps],
                startedAt,
                ...(input === undefined ? {} : { input }),
              },
            }
          : {}),
        at: new Date().toISOString(),
      };
      try {
        await sink.record(checkpoint);
      } catch (err) {
        // The step happened; the record of it did not. Continuing would run the
        // next step from a cursor no restart could recover, so the run stops
        // here with the reason on the trail rather than pretending otherwise.
        status = "error";
        waiting = undefined;
        steps.push({
          stepId: step.id,
          kind: step.kind,
          status: "error",
          error: `checkpoint_failed:${step.id}: ${errText(err)}`,
          next: null,
          ms: 0,
        });
        break;
      }
    }

    if (status === "error" || status === "waiting") break;
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
    input,
    steps,
    mocked: opts.mocked,
    ...(waiting
      ? {
          waiting,
          resume: {
            stepId: waiting.stepId,
            outputs,
            steps,
            startedAt,
            ...(input === undefined ? {} : { input }),
          },
        }
      : {}),
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
        case "lacrew_human_gate":
          // Nobody is here to answer. Parking the run is the honest response —
          // a canned "yes" offline would make a blocking gate look like one
          // that passes, which is the one thing it must never do.
          throw new FlowWaitingError({
            reason: "human_gate",
            token: `mock-gate-${String(args.stepId ?? "step")}`,
            detail: `waiting on a human at "${String(args.label ?? args.stepId ?? "gate")}" — no human surface is attached`,
          });
        case "lacrew_governance":
          return {
            action: String(args.action ?? ""),
            proposalId: String(args.proposalId ?? "mock-proposal-1"),
            txHash: "0xmockgov",
            mocked: true,
          };
        default:
          // A connector tool (`<connector>.<route>`) is the operator's, not this
          // package's: offline the call cannot happen, so the step reports that
          // it did not rather than failing the run or inventing a response.
          // Anything else is a typo in a `lacrew_*` name and must still throw.
          if (/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/.test(name)) {
            const [connector, route] = name.split(".") as [string, string];
            return {
              connector,
              route,
              ok: false,
              status: 0,
              body: null,
              note: "no connector registered — nothing was called",
              mocked: true,
            };
          }
          // An external MCP tool (`mcp__<server>__<tool>`, F2.30) is the
          // operator's too, and offline there is no server to ask. Same answer
          // for the same reason: report that nothing was called.
          if (/^mcp__[a-z][a-z0-9-]*__.+$/.test(name)) {
            const rest = name.slice(5);
            const split = rest.indexOf("__");
            return {
              server: rest.slice(0, split),
              tool: rest.slice(split + 2),
              untrusted: true,
              content: null,
              isError: true,
              note: "no external MCP server attached — nothing was called",
              mocked: true,
            };
          }
          throw new Error(`Unknown mock tool: ${name}`);
      }
    },
  };
}
