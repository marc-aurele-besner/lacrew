/**
 * Evals: a scenario runs the real flow against fakes, and says what happened
 * in the operator's words (F2.29).
 *
 * A blueprint encodes an enforcement thesis — "the advisory desk cannot trade",
 * "merging needs an admitted authority" — and that thesis lives in the edges of
 * a flow, not in a unit test's reach. Editing a template, an interpolator, or a
 * connector route can re-introduce a write on DENY without anything going red.
 * An eval is the scenario runner that catches it: golden input, scripted model,
 * recording connector, policy stub, and assertions about **ports taken and
 * routes called** rather than about strings a model happened to produce.
 *
 * Three rules keep an eval from becoming a lie:
 *
 * 1. **It runs the real definition.** No eval mode inside `runFlow`, no
 *    shortened flow: the same steps, the same interpolation, the same verdict
 *    routing the orchestrator executes. Only the far side of each call is fake.
 * 2. **It cannot reach anything.** The backend has no network code path, and
 *    the runner blocks `fetch` for the duration of a run — so "no HTTP on DENY"
 *    is enforced rather than promised, and a connector that grew a live call
 *    fails the suite instead of quietly hitting the API.
 * 3. **Its mocks may not contradict the blueprint.** A scenario cannot make
 *    itself green by pretending an unadmitted target is admitted; admitting one
 *    has to be declared (`admitsUnadmitted`), which is how the one scenario that
 *    means it — the drift alert — stays possible and visible.
 *
 * Determinism is the whole product: no clock, no randomness, no ordering luck.
 * Run ids are derived from the scenario id, model replies are scripted, and an
 * unscripted completion returns one constant string rather than anything a
 * branch could read two ways.
 */

import { crewBlueprints, getCrewBlueprint } from "./crewBlueprints.js";
import {
  bindCrewFlow,
  type CrewBindings,
  type CrewBlueprint,
} from "./crews.js";
import { createMockFlowBackend, FlowWaitingError, runFlow } from "./run.js";
import { flowTemplates, getFlowTemplate } from "./templates.js";
import type {
  FlowBackend,
  FlowDefinition,
  FlowPrincipal,
  FlowRunResult,
  FlowRunStatus,
  FlowStepTrace,
  Verdict,
} from "./types.js";

/** `<connector>.<route>` — the operator's own surface, never `lacrew_*`. */
const CONNECTOR_ROUTE = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9_]*)$/;

/** What an unscripted completion returns. One constant, so no branch is a coin toss. */
export const EVAL_MODEL_STUB = "[eval] unscripted completion";

/* ------------------------------------------------------------------------- *
 * The manifest
 * ------------------------------------------------------------------------- */

/**
 * One scripted model turn.
 *
 * `when` is matched as a substring of the interpolated system + prompt, which
 * is what identifies a step from the backend's side — `complete()` is handed a
 * rendered prompt, not a step id. Entries are consumed in declaration order so
 * a flow that asks the same question twice can be answered differently the
 * second time; `always` opts out of being consumed.
 */
export type EvalModelReply = {
  when?: string;
  reply: string;
  always?: boolean;
};

/**
 * The canned far side of a tool call. `results` answers successive calls in
 * order and falls back to `result` once exhausted; `error` throws, which is how
 * a scenario pins what a flow does when a route is down.
 */
export type EvalToolMock = {
  result?: unknown;
  results?: unknown[];
  error?: string;
};

/**
 * What policy answers, in blueprint vocabulary.
 *
 * Targets are named by blueprint target id (`merge-authority`) or by raw
 * address. Unlisted targets fall back to the blueprint's own `whitelisted`
 * flag, so a scenario says only what it is actually pinning — and admitting a
 * venue in the blueprint turns every eval that assumed the refusal red, which
 * is the regression this exists to catch.
 */
export type EvalPolicyStub = {
  /** Verdict for a target neither the scenario nor the blueprint answers for. */
  default?: Verdict;
  targets?: Record<string, Verdict>;
  /**
   * Blueprint target ids this scenario deliberately admits despite the
   * blueprint refusing them. Required for that mock to be accepted: an
   * unacknowledged ALLOW over an unadmitted target is how an eval would be made
   * green by granting the crew authority it does not have.
   */
  admitsUnadmitted?: string[];
};

/** What a person picked at a `human` gate. Unlisted gates stay open. */
export type EvalGateAnswer = {
  outcome: "answered" | "timed_out";
  optionId?: string;
  answeredBy?: string;
};

export type FlowEvalMocks = {
  model?: EvalModelReply[];
  /** Tool name (`github.merge_pull_request`, `lacrew_check_policy`) → canned far side. */
  tools?: Record<string, EvalToolMock>;
  policy?: EvalPolicyStub;
  /** Gate step id → the answer. */
  gates?: Record<string, EvalGateAnswer>;
};

/**
 * What the run must have done. Every assertion is about the product — a port
 * taken, a verdict read, a route called — never about a model's prose, which
 * is the flakiness this suite refuses to import.
 */
export type FlowEvalExpect = {
  status?: FlowRunStatus;
  /** Set when the run is expected to park: why, and where. */
  waiting?: { reason?: string; stepId?: string };
  /** Step ids that must appear in the trace, in this order (gaps allowed). */
  ran?: string[];
  /** Step ids that must not appear at all. */
  notRan?: string[];
  /** Step id → the step it routed to; `null` asserts the run stopped there. */
  port?: Record<string, string | null>;
  /** Step id → the verdict the run read off policy. */
  verdict?: Record<string, Verdict>;
  /** Tool name (or `model`) → exact call count. */
  called?: Record<string, number>;
  /** Names that must never have been called. */
  notCalled?: string[];
  /** No `<connector>.<route>` may be called at all — the "no HTTP" assertion. */
  noConnectorCalls?: boolean;
  /** A human gate was opened and left open for someone. */
  questionOpen?: boolean;
  /** Substrings that must appear somewhere in the run's trace. */
  auditIncludes?: string[];
};

export type FlowEvalScenario = {
  /** Stable id; also seeds the run id, so a failure reads the same every time. */
  id: string;
  /** What this scenario pins, in one line. */
  describe?: string;
  /** Template id or definition id. Ignored when `definition` is given. */
  flow?: string;
  /** An inline definition, for evals of a flow that is not a shipped template. */
  definition?: FlowDefinition;
  /** Blueprint supplying `{{crew.*}}` / `{{target.*}}` bindings and policy vocabulary. */
  blueprint?: string;
  /** Overrides for the derived bindings, when a scenario needs a specific address. */
  bindings?: CrewBindings;
  /** The seat the run executes as: a blueprint role id, or an address. */
  asAgent?: string;
  /** Run input; an object is serialized exactly as the orchestrator would. */
  input?: unknown;
  mocks?: FlowEvalMocks;
  expect: FlowEvalExpect;
};

/* ------------------------------------------------------------------------- *
 * Results
 * ------------------------------------------------------------------------- */

/** One call the run made, as the recorder saw it. */
export type FlowEvalCall = {
  kind: "tool" | "model";
  /** Tool name, or `model` for a completion. */
  name: string;
  args?: Record<string, unknown>;
  /** Set when `name` is a `<connector>.<route>` rather than a LaCrew tool. */
  connector?: string;
};

export type FlowEvalFailure = {
  /** Which assertion broke: `called`, `port`, `noConnectorCalls`, `setup`… */
  assertion: string;
  /** The sentence an operator reads first. */
  detail: string;
  expected?: unknown;
  actual?: unknown;
};

export type FlowEvalResult = {
  id: string;
  ok: boolean;
  flowId: string;
  describe?: string;
  failures: FlowEvalFailure[];
  /** Absent only when the scenario could not be stood up at all. */
  run?: FlowRunResult;
  calls: FlowEvalCall[];
  /** Gate step ids left open at the end of the run. */
  gatesOpen: string[];
};

export type FlowEvalSuiteResult = {
  ok: boolean;
  passed: number;
  failed: number;
  results: FlowEvalResult[];
};

/* ------------------------------------------------------------------------- *
 * Deterministic bindings
 * ------------------------------------------------------------------------- */

/**
 * A stable fake address per (blueprint, kind, id).
 *
 * Derived rather than random: a scenario that prints an address in a failure
 * must print the same one tomorrow, and a recorded expectation naming a seat
 * must keep naming that seat across runs and machines.
 */
export function evalAddress(seed: string): string {
  let word = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    word ^= seed.charCodeAt(i);
    word = Math.imul(word, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += word.toString(16).padStart(8, "0");
    word = Math.imul(word ^ (i + 1), 0x01000193) >>> 0;
  }
  return `0x${out}`;
}

/** Every seat, target, and dedicated policy of a blueprint, as fake addresses. */
export function evalCrewBindings(bp: CrewBlueprint): Required<CrewBindings> {
  const roles: Record<string, string> = {};
  const targets: Record<string, string> = {};
  const policies: Record<string, string> = {};
  for (const role of bp.roles) {
    roles[role.id] = evalAddress(`${bp.id}:crew:${role.id}`);
    if (role.dedicatedPolicy)
      policies[role.id] = evalAddress(`${bp.id}:policy:${role.id}`);
  }
  for (const target of bp.targets)
    targets[target.id] = evalAddress(`${bp.id}:target:${target.id}`);
  return { roles, targets, policies };
}

/* ------------------------------------------------------------------------- *
 * The backend under the scenario
 * ------------------------------------------------------------------------- */

type PolicyResolver = (target: string | undefined) => Verdict;

type EvalBackendState = {
  calls: FlowEvalCall[];
  gatesOpen: Set<string>;
  gatesAnswered: Set<string>;
};

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * The recording backend. Nothing here reaches a network: every branch either
 * returns a canned value, synthesizes a verdict, or reports that no connector
 * was registered — which is what an offline run of a connector route means.
 */
function createEvalBackend(
  mocks: FlowEvalMocks,
  policy: PolicyResolver,
  state: EvalBackendState,
): FlowBackend {
  const replies = (mocks.model ?? []).map((r) => ({ ...r, used: false }));
  const toolCalls = new Map<string, number>();
  let intents = 0;

  const nextReply = (rendered: string): string => {
    for (const entry of replies) {
      if (entry.used && !entry.always) continue;
      if (entry.when !== undefined && !rendered.includes(entry.when)) continue;
      if (!entry.always) entry.used = true;
      return entry.reply;
    }
    return EVAL_MODEL_STUB;
  };

  const verdictResult = (
    verdict: Verdict,
    extra: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (verdict === "ALLOW")
      return { verdict, txHash: `0xeval${++intents}`, mocked: true, ...extra };
    if (verdict === "ESCALATE") {
      return {
        verdict,
        intentId: `eval-intent-${++intents}`,
        proposalId: `eval-proposal-${intents}`,
        mocked: true,
        ...extra,
      };
    }
    return { verdict, mocked: true, ...extra };
  };

  return {
    async complete({ system, prompt, model }) {
      state.calls.push({ kind: "model", name: "model" });
      return {
        text: nextReply(`${system ?? ""}\n${prompt}`),
        model: model ?? "eval",
        mocked: true,
      };
    },

    async callTool(name, args) {
      const connector = CONNECTOR_ROUTE.exec(name)?.[1];
      state.calls.push({
        kind: "tool",
        name,
        args,
        ...(connector ? { connector } : {}),
      });
      const seen = (toolCalls.get(name) ?? 0) + 1;
      toolCalls.set(name, seen);

      const mock = mocks.tools?.[name];
      if (mock) {
        if (mock.error) throw new Error(mock.error);
        if (mock.results && seen <= mock.results.length)
          return mock.results[seen - 1];
        if (mock.results && mock.result === undefined) {
          throw new Error(`eval_mock_exhausted:${name}:call ${seen}`);
        }
        return mock.result;
      }

      switch (name) {
        case "lacrew_check_policy":
          return {
            verdict: policy(args.target as string | undefined),
            mocked: true,
          };
        case "lacrew_propose_intent":
          return verdictResult(policy(args.target as string | undefined), {});
        case "lacrew_org_action":
          return verdictResult(policy(args.target as string | undefined), {
            action: String(args.action ?? ""),
          });
        case "lacrew_set_budget":
          return verdictResult(policy(args.node as string | undefined), {
            action: String(args.action ?? ""),
          });
        case "lacrew_human_gate": {
          const stepId = String(args.stepId ?? "gate");
          const answer = mocks.gates?.[stepId];
          if (!answer) {
            // Nobody scripted an answer, so nobody answered. Parking is the
            // honest outcome — a canned yes here would make a blocking gate
            // look like one that passes, which is the one thing it must never do.
            state.gatesOpen.add(stepId);
            throw new FlowWaitingError({
              reason: "human_gate",
              token: `eval-gate-${stepId}`,
              detail: `waiting on a human at "${String(args.label ?? stepId)}"`,
            });
          }
          state.gatesAnswered.add(stepId);
          return {
            outcome: answer.outcome,
            ...(answer.optionId ? { optionId: answer.optionId } : {}),
            ...(answer.answeredBy ? { answeredBy: answer.answeredBy } : {}),
            gateId: `eval-gate-${stepId}`,
            mocked: true,
          };
        }
        default:
          break;
      }

      if (connector) {
        // Offline, an unmocked route did not happen — and saying so beats both
        // failing the run and inventing a body a downstream step would reason
        // over. The call is still recorded, which is what `notCalled` reads.
        const route = name.slice(connector.length + 1);
        return {
          connector,
          route,
          ok: false,
          status: 0,
          body: null,
          note: "no connector mock — nothing was called",
          mocked: true,
        };
      }

      // Everything else is the detached mock's business: org trees, pending
      // intents, governance. A typo in a `lacrew_*` name still throws there.
      return createMockFlowBackend().callTool(name, args);
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Network guard
 * ------------------------------------------------------------------------- */

let blockDepth = 0;
let blockedAttempts: string[] = [];

/**
 * Run `fn` with `fetch` refused.
 *
 * The backend has no network path, so this catches the case that matters: code
 * *under* a flow — a connector client, an SDK, a model provider — that grew a
 * live call. "Evals never hit a third-party network" is then a property of the
 * runner rather than a claim in a doc.
 */
export async function withNetworkBlocked<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; attempts: string[] }> {
  const outer = blockDepth === 0;
  const before = blockedAttempts.length;
  const real = globalThis.fetch;
  if (outer) {
    globalThis.fetch = ((input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input === "object" && "url" in input
            ? String((input as { url: unknown }).url)
            : String(input);
      blockedAttempts.push(url);
      return Promise.reject(new Error(`eval_network_blocked: ${url}`));
    }) as typeof globalThis.fetch;
  }
  blockDepth += 1;
  try {
    const value = await fn();
    return { value, attempts: blockedAttempts.slice(before) };
  } finally {
    blockDepth -= 1;
    if (outer) {
      globalThis.fetch = real;
      blockedAttempts = [];
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Running one scenario
 * ------------------------------------------------------------------------- */

type Prepared = {
  def: FlowDefinition;
  principal?: FlowPrincipal;
  input?: string;
  policy: PolicyResolver;
  setupFailures: FlowEvalFailure[];
};

function prepare(scenario: FlowEvalScenario): Prepared {
  const setupFailures: FlowEvalFailure[] = [];
  const bp = scenario.blueprint
    ? getCrewBlueprint(scenario.blueprint)
    : undefined;
  if (scenario.blueprint && !bp) {
    setupFailures.push({
      assertion: "setup",
      detail: `no blueprint "${scenario.blueprint}"`,
    });
  }

  let def =
    scenario.definition ??
    (scenario.flow ? getFlowTemplate(scenario.flow)?.definition : undefined);
  if (!def) {
    setupFailures.push({
      assertion: "setup",
      detail: `no flow "${scenario.flow ?? "(none named)"}" — give a template id, a definition id, or an inline definition`,
    });
    return {
      def: { id: scenario.flow ?? scenario.id, name: scenario.id, steps: [] },
      policy: () => "ESCALATE",
      setupFailures,
    };
  }

  const derived = bp
    ? evalCrewBindings(bp)
    : { roles: {}, targets: {}, policies: {} };
  const bindings: CrewBindings = {
    roles: { ...derived.roles, ...scenario.bindings?.roles },
    targets: { ...derived.targets, ...scenario.bindings?.targets },
    policies: { ...derived.policies, ...scenario.bindings?.policies },
  };
  try {
    def = bindCrewFlow(def, bindings);
  } catch (err) {
    setupFailures.push({
      assertion: "setup",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Address → blueprint target id, so a scenario names targets the way the
  // blueprint does and a failure prints `target.dex-router`, not 0xe3c9….
  const targetNames = new Map<string, string>();
  for (const [id, address] of Object.entries(bindings.targets ?? {}))
    targetNames.set(address, id);

  const stub = scenario.mocks?.policy;
  const admitted = new Set(stub?.admitsUnadmitted ?? []);
  for (const [key, verdict] of Object.entries(stub?.targets ?? {})) {
    const id = targetNames.get(key) ?? key;
    const target = bp?.targets.find((t) => t.id === id);
    if (
      verdict === "ALLOW" &&
      target &&
      !target.whitelisted &&
      !admitted.has(id)
    ) {
      setupFailures.push({
        assertion: "mock_contradicts_blueprint",
        detail:
          `the scenario mocks ALLOW for "${id}", which "${bp!.id}" deliberately does not admit. ` +
          `If the scenario is about that drift, list it in mocks.policy.admitsUnadmitted.`,
        expected: "DENY",
        actual: verdict,
      });
    }
  }

  const policy: PolicyResolver = (target) => {
    if (target) {
      const byAddress = stub?.targets?.[target];
      if (byAddress) return byAddress;
      const id = targetNames.get(target);
      if (id) {
        const byId = stub?.targets?.[id];
        if (byId) return byId;
        const known = bp?.targets.find((t) => t.id === id);
        if (known) return known.whitelisted ? "ALLOW" : "DENY";
      }
    }
    // Nothing named it and nothing admits it. ESCALATE rather than ALLOW: an
    // unanswered policy question must never read as approval.
    return stub?.default ?? "ESCALATE";
  };

  let principal: FlowPrincipal | undefined;
  if (scenario.asAgent) {
    const role = bp?.roles.find((r) => r.id === scenario.asAgent);
    if (role) {
      principal = { agent: bindings.roles![role.id]!, nodeKind: role.kind };
      const owners = bp!.roles.filter((r) => r.flows.includes(def!.id));
      if (owners.length > 0 && !role.flows.includes(def.id)) {
        setupFailures.push({
          assertion: "setup",
          detail:
            `"${role.id}" does not run "${def.id}" in "${bp!.id}" — ${owners.map((o) => `"${o.id}"`).join(", ")} does. ` +
            "A run fired as the wrong seat gets the wrong policy stack.",
        });
      }
    } else if (scenario.asAgent.startsWith("0x")) {
      principal = { agent: scenario.asAgent };
    } else {
      setupFailures.push({
        assertion: "setup",
        detail: `asAgent "${scenario.asAgent}" is neither a role of the blueprint nor an address`,
      });
    }
  }

  const input =
    scenario.input === undefined
      ? undefined
      : typeof scenario.input === "string"
        ? scenario.input
        : JSON.stringify(scenario.input);

  return {
    def,
    ...(principal ? { principal } : {}),
    ...(input === undefined ? {} : { input }),
    policy,
    setupFailures,
  };
}

/* ------------------------------------------------------------------------- *
 * Assertions
 * ------------------------------------------------------------------------- */

function traceText(steps: FlowStepTrace[]): string {
  return steps
    .map((s) =>
      [
        s.stepId,
        s.status,
        s.verdict ?? "",
        s.summary ?? "",
        s.error ?? "",
        JSON.stringify(s.output ?? null),
      ].join(" "),
    )
    .join("\n");
}

/** Ordered-subsequence check: `ran` names milestones, not every step. */
function containsInOrder(
  actual: string[],
  wanted: string[],
): string | undefined {
  let i = 0;
  for (const step of actual) {
    if (step === wanted[i]) i += 1;
    if (i === wanted.length) return undefined;
  }
  return wanted[i];
}

function assertRun(
  expect: FlowEvalExpect,
  run: FlowRunResult,
  calls: FlowEvalCall[],
  gatesOpen: string[],
): FlowEvalFailure[] {
  const failures: FlowEvalFailure[] = [];
  const ranIds = run.steps.map((s) => s.stepId);
  const lastTrace = (id: string): FlowStepTrace | undefined =>
    [...run.steps].reverse().find((s) => s.stepId === id);
  const countOf = (name: string): number =>
    calls.filter((c) => c.name === name).length;

  if (expect.status && run.status !== expect.status) {
    const why = run.steps.find((s) => s.status === "error")?.error;
    failures.push({
      assertion: "status",
      detail: `run ended "${run.status}", expected "${expect.status}"${why ? ` — ${why}` : ""}`,
      expected: expect.status,
      actual: run.status,
    });
  }

  if (expect.waiting) {
    if (!run.waiting) {
      failures.push({
        assertion: "waiting",
        detail: "the run did not park",
        expected: expect.waiting,
        actual: null,
      });
    } else {
      if (
        expect.waiting.reason &&
        run.waiting.reason !== expect.waiting.reason
      ) {
        failures.push({
          assertion: "waiting",
          detail: `parked on "${run.waiting.reason}", expected "${expect.waiting.reason}"`,
          expected: expect.waiting.reason,
          actual: run.waiting.reason,
        });
      }
      if (
        expect.waiting.stepId &&
        run.waiting.stepId !== expect.waiting.stepId
      ) {
        failures.push({
          assertion: "waiting",
          detail: `parked at "${run.waiting.stepId}", expected "${expect.waiting.stepId}"`,
          expected: expect.waiting.stepId,
          actual: run.waiting.stepId,
        });
      }
    }
  }

  if (expect.ran) {
    const missed = containsInOrder(ranIds, expect.ran);
    if (missed !== undefined) {
      failures.push({
        assertion: "ran",
        detail: `"${missed}" never ran (in that order). Path taken: ${ranIds.join(" → ") || "(nothing)"}`,
        expected: expect.ran,
        actual: ranIds,
      });
    }
  }

  for (const step of expect.notRan ?? []) {
    if (ranIds.includes(step)) {
      failures.push({
        assertion: "notRan",
        detail: `"${step}" ran and must not have. Path taken: ${ranIds.join(" → ")}`,
        expected: `${step} not to run`,
        actual: ranIds,
      });
    }
  }

  for (const [step, port] of Object.entries(expect.port ?? {})) {
    const trace = lastTrace(step);
    if (!trace) {
      failures.push({
        assertion: "port",
        detail: `"${step}" never ran, so it took no port`,
        expected: port,
        actual: null,
      });
      continue;
    }
    if (trace.next !== port) {
      failures.push({
        assertion: "port",
        detail: `"${step}" routed to ${trace.next === null ? "nothing (the run stopped)" : `"${trace.next}"`}, expected ${port === null ? "nothing" : `"${port}"`}`,
        expected: port,
        actual: trace.next,
      });
    }
  }

  for (const [step, verdict] of Object.entries(expect.verdict ?? {})) {
    const trace = lastTrace(step);
    if (!trace) {
      failures.push({
        assertion: "verdict",
        detail: `"${step}" never ran, so it read no verdict`,
        expected: verdict,
        actual: null,
      });
      continue;
    }
    if (trace.verdict !== verdict) {
      failures.push({
        assertion: "verdict",
        detail: `"${step}" read ${trace.verdict ?? "no verdict"}, expected ${verdict}`,
        expected: verdict,
        actual: trace.verdict ?? null,
      });
    }
  }

  for (const [name, times] of Object.entries(expect.called ?? {})) {
    const actual = countOf(name);
    if (actual !== times) {
      failures.push({
        assertion: "called",
        detail: `${name} was called ${actual}×, expected ${times}×`,
        expected: times,
        actual,
      });
    }
  }

  for (const name of expect.notCalled ?? []) {
    const actual = countOf(name);
    if (actual > 0) {
      failures.push({
        assertion: "notCalled",
        detail: `${name} was called ${actual}× and must not have been`,
        expected: 0,
        actual,
      });
    }
  }

  if (expect.noConnectorCalls) {
    const routes = calls.filter((c) => c.connector).map((c) => c.name);
    if (routes.length > 0) {
      failures.push({
        assertion: "noConnectorCalls",
        detail: `the run called ${routes.length} connector route(s): ${[...new Set(routes)].join(", ")}`,
        expected: [],
        actual: routes,
      });
    }
  }

  if (expect.questionOpen !== undefined) {
    const open = gatesOpen.length > 0;
    if (open !== expect.questionOpen) {
      failures.push({
        assertion: "questionOpen",
        detail: expect.questionOpen
          ? "no human gate was left open"
          : `a human gate was left open: ${gatesOpen.join(", ")}`,
        expected: expect.questionOpen,
        actual: open,
      });
    }
  }

  const audit = traceText(run.steps);
  for (const needle of expect.auditIncludes ?? []) {
    if (!audit.includes(needle)) {
      failures.push({
        assertion: "auditIncludes",
        detail: `the trail never says "${truncate(needle, 60)}"`,
        expected: needle,
        actual: null,
      });
    }
  }

  return failures;
}

/* ------------------------------------------------------------------------- *
 * Public entry points
 * ------------------------------------------------------------------------- */

/** Run one scenario. Never throws: a broken scenario is a failing eval. */
export async function runFlowEval(
  scenario: FlowEvalScenario,
): Promise<FlowEvalResult> {
  const prepared = prepare(scenario);
  const state: EvalBackendState = {
    calls: [],
    gatesOpen: new Set(),
    gatesAnswered: new Set(),
  };

  if (prepared.setupFailures.length > 0) {
    return {
      id: scenario.id,
      ok: false,
      flowId: prepared.def.id,
      ...(scenario.describe ? { describe: scenario.describe } : {}),
      failures: prepared.setupFailures,
      calls: [],
      gatesOpen: [],
    };
  }

  const backend = createEvalBackend(
    scenario.mocks ?? {},
    prepared.policy,
    state,
  );
  let run: FlowRunResult;
  let attempts: string[];
  try {
    const outcome = await withNetworkBlocked(() =>
      runFlow(prepared.def, backend, {
        // Derived from the scenario so a failure reads identically every run.
        runId: `eval-${scenario.id}`,
        mocked: true,
        ...(prepared.input === undefined ? {} : { input: prepared.input }),
        ...(prepared.principal ? { principal: prepared.principal } : {}),
      }),
    );
    run = outcome.value;
    attempts = outcome.attempts;
  } catch (err) {
    return {
      id: scenario.id,
      ok: false,
      flowId: prepared.def.id,
      ...(scenario.describe ? { describe: scenario.describe } : {}),
      failures: [
        {
          assertion: "setup",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      calls: state.calls,
      gatesOpen: [...state.gatesOpen],
    };
  }

  const gatesOpen = [...state.gatesOpen].filter(
    (id) => !state.gatesAnswered.has(id),
  );
  const failures = assertRun(scenario.expect, run, state.calls, gatesOpen);
  for (const url of attempts) {
    failures.unshift({
      assertion: "network",
      detail: `the run tried to reach ${url}. An eval must never leave the machine.`,
      expected: "no HTTP",
      actual: url,
    });
  }

  return {
    id: scenario.id,
    ok: failures.length === 0,
    flowId: run.flowId,
    ...(scenario.describe ? { describe: scenario.describe } : {}),
    failures,
    run,
    calls: state.calls,
    gatesOpen,
  };
}

/** Run a suite in declaration order. Sequential on purpose: no ordering luck. */
export async function runFlowEvals(
  scenarios: readonly FlowEvalScenario[],
): Promise<FlowEvalSuiteResult> {
  const results: FlowEvalResult[] = [];
  for (const scenario of scenarios) results.push(await runFlowEval(scenario));
  const failed = results.filter((r) => !r.ok).length;
  return { ok: failed === 0, passed: results.length - failed, failed, results };
}

/* ------------------------------------------------------------------------- *
 * Coverage
 * ------------------------------------------------------------------------- */

export type FlowEvalCoverage = {
  /** First-party flow definition ids with no scenario at all. */
  flowsWithoutEvals: string[];
  /** Blueprints shipping flows, none of which any scenario runs. */
  blueprintsWithoutEvals: string[];
  /** Flow definition id → how many scenarios run it. */
  byFlow: Record<string, number>;
};

/**
 * What the suite does not cover.
 *
 * Reported rather than enforced: a threshold nobody agreed to would be a red CI
 * on the day someone adds a template, and the first fix for that is to delete
 * the check. Naming the gap is what makes adding a scenario the obvious move.
 */
export function evalCoverage(
  scenarios: readonly FlowEvalScenario[],
): FlowEvalCoverage {
  const byFlow: Record<string, number> = {};
  for (const t of flowTemplates) byFlow[t.definition.id] = 0;
  for (const s of scenarios) {
    const id =
      s.definition?.id ??
      (s.flow ? getFlowTemplate(s.flow)?.definition.id : undefined);
    if (!id) continue;
    byFlow[id] = (byFlow[id] ?? 0) + 1;
  }
  const covered = new Set(
    Object.entries(byFlow)
      .filter(([, n]) => n > 0)
      .map(([id]) => id),
  );
  const blueprintsWithoutEvals = crewBlueprints
    .filter(
      (bp) => bp.flows.length > 0 && !bp.flows.some((f) => covered.has(f)),
    )
    .map((bp) => bp.id);
  return {
    flowsWithoutEvals: Object.entries(byFlow)
      .filter(([, n]) => n === 0)
      .map(([id]) => id)
      .sort(),
    blueprintsWithoutEvals,
    byFlow,
  };
}

/* ------------------------------------------------------------------------- *
 * Reporting
 * ------------------------------------------------------------------------- */

/** The report a CI log and a terminal both read: one line per scenario, then the diffs. */
export function formatEvalReport(
  suite: FlowEvalSuiteResult,
  coverage?: FlowEvalCoverage,
): string {
  const lines: string[] = [];
  for (const result of suite.results) {
    lines.push(
      `${result.ok ? "✓" : "✗"} ${result.id} · ${result.flowId}` +
        (result.describe ? `\n    ${result.describe}` : ""),
    );
    for (const failure of result.failures) {
      lines.push(`    ✗ ${failure.assertion}: ${failure.detail}`);
    }
  }
  lines.push("");
  lines.push(
    suite.ok
      ? `${suite.passed} scenario${suite.passed === 1 ? "" : "s"} green.`
      : `${suite.failed} of ${suite.results.length} scenarios failed.`,
  );
  if (coverage && coverage.flowsWithoutEvals.length > 0) {
    lines.push(
      `\n⚠ ${coverage.flowsWithoutEvals.length} first-party flow(s) have no eval: ` +
        coverage.flowsWithoutEvals.join(", "),
    );
  }
  if (coverage && coverage.blueprintsWithoutEvals.length > 0) {
    lines.push(
      `⚠ blueprints with no eval at all: ${coverage.blueprintsWithoutEvals.join(", ")}`,
    );
  }
  return lines.join("\n");
}
