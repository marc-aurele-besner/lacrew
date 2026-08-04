/**
 * Plan-required mode (PRD F2.31): no plan, no side effect.
 *
 * A crew's thread already carries `plan` messages — an agent saying what it is
 * about to do, in the one window where a human can still redirect it. Nothing
 * made the agent say it. A flow could merge, publish or propose a spend with an
 * empty thread behind it, and the operator's first sight of the work was the
 * audit row after the fact. This module is the switch that closes that gap:
 * with plan-required on, a side-effecting step refuses unless the acting
 * principal has already stated, on the record, what it intends.
 *
 * ## What it is not
 *
 *   - **It is not approval.** A plan is still a claim (`conversation.ts`), and
 *     posting one admits nothing: the spend meets the policy stack, escalates,
 *     and waits for its approval exactly as before. Plan-required only bounds
 *     *when* a crew may act — never *what* it may do.
 *   - **It is not a human gate.** F2.27 stops the run until a person decides.
 *     This mode asks nobody: the agent speaks first and then proceeds. The two
 *     compose — a crew can require a plan *and* gate the merge behind a human —
 *     and confusing them would sell "the agent wrote a sentence" as "someone
 *     agreed", which is the one misreading this feature must not invite.
 *   - **It is not semantic review.** v1 checks existence, authorship, thread
 *     and freshness. Whether the plan actually describes the effect is a
 *     judgement no string comparison makes honestly, so it is deliberately not
 *     claimed. What the mode guarantees is that a human reading the thread saw
 *     *something* before the effect, recent enough to still be the current
 *     intent.
 *
 * ## Why freshness is bounded
 *
 * Without a window, one plan posted at 9am rubber-stamps everything the crew
 * does that day, and the control degrades into a checkbox the agent ticked
 * once. So a qualifying plan is recent — or, for a long-running pipeline, one
 * the same run already emitted, which is the same guarantee: the operator saw
 * this run say what it was about to do.
 *
 * The shape, the classification and the qualification test live here, in the
 * pure package, so a CLI, an eval and a control plane can all answer "would
 * this have been blocked?" without a running orchestrator. Storage, the
 * conversation read and the refusal itself live in `@lacrew/orchestrator`.
 */

/**
 * How much of a crew's behaviour the requirement covers.
 *
 * `off` — nothing changes.
 * `spends_only` — onchain proposes (a flow's `gate` step, `lacrew_propose_intent`)
 *   need a plan. The money path, and nothing else.
 * `side_effects` — spends *plus* connector writes, external MCP writes and the
 *   org / budget / governance mutators. Everything that reaches past the
 *   process, which is the setting a supervised desk wants.
 */
export type PlanRequiredMode = "off" | "spends_only" | "side_effects";

export const PLAN_REQUIRED_MODES: PlanRequiredMode[] = ["off", "spends_only", "side_effects"];

export function isPlanRequiredMode(value: unknown): value is PlanRequiredMode {
  return typeof value === "string" && PLAN_REQUIRED_MODES.includes(value as PlanRequiredMode);
}

/**
 * What a call would do, in the two tiers the modes distinguish.
 *
 * `spend` — an onchain propose. `write` — anything else that changes something
 * outside this process. Reads carry no effect at all and are never gated: a
 * requirement in front of a read is a control that protects nothing and trains
 * a crew to post plans nobody reads.
 */
export type PlanRequiredEffect = "spend" | "write";

/** Where a requirement applies — the same three levels connector modes use. */
export type PlanRequiredScope =
  { level: "workspace" } | { level: "crew"; ref: string } | { level: "agent"; ref: string };

/**
 * How long a plan stays current, by default.
 *
 * Half an hour is long enough for a model to plan, call two tools and act, and
 * short enough that yesterday's plan cannot authorise today's publish.
 */
export const PLAN_REQUIRED_DEFAULT_WINDOW_MS = 30 * 60_000;

/** A plan shorter than this is not a plan. Bounds the "ok" that satisfies nothing. */
export const PLAN_REQUIRED_DEFAULT_MIN_CHARS = 24;

/** Windows outside this are refused: an unbounded window is `off` wearing a badge. */
export const PLAN_REQUIRED_MIN_WINDOW_MS = 60_000;
export const PLAN_REQUIRED_MAX_WINDOW_MS = 24 * 60 * 60_000;

export type PlanRequiredRule = {
  scope: PlanRequiredScope;
  mode: PlanRequiredMode;
  /** Freshness window in ms. Defaults to `PLAN_REQUIRED_DEFAULT_WINDOW_MS`. */
  windowMs?: number;
  /** Minimum plan body length. Defaults to `PLAN_REQUIRED_DEFAULT_MIN_CHARS`. */
  minPlanChars?: number;
  /**
   * Whether the plan of the principal that delegated this work counts.
   *
   * Off by default, and that default is the point: the seat doing the spending
   * is the one whose intent a reader needs, and a manager's "have the desk
   * rebalance" is not the worker's statement of what it is about to do. On, for
   * handoff-shaped crews where the manager plans and workers execute.
   */
  acceptUpstreamPlan?: boolean;
};

/**
 * A rule as stored and served: every setting filled in, so a reader never has
 * to know this module's defaults to know what a scope is enforcing. `at` is
 * when an operator last set it.
 */
export type PlanRequiredRecord = PlanRequiredRule & {
  windowMs: number;
  minPlanChars: number;
  acceptUpstreamPlan: boolean;
  at: string;
};

export type PlanRequiredSettings = {
  mode: PlanRequiredMode;
  windowMs: number;
  minPlanChars: number;
  acceptUpstreamPlan: boolean;
};

export type PlanRequiredResolution = PlanRequiredSettings & {
  /** What decided it — so an inherited value is legible in a UI. */
  source: { kind: "default" } | { kind: "rule"; scope: PlanRequiredScope };
};

/** Who is acting, for rule resolution. `managers` arrives nearest-first. */
export type PlanRequiredSubject = {
  principal?: string;
  managers?: Iterable<string>;
};

const norm = (value: string): string => value.trim().toLowerCase();

export function planRequiredScopeKey(scope: PlanRequiredScope): string {
  return scope.level === "workspace" ? "workspace" : `${scope.level}:${norm(scope.ref)}`;
}

export function parsePlanRequiredScope(raw: unknown): PlanRequiredScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const level = (raw as { level?: unknown }).level;
  const ref = (raw as { ref?: unknown }).ref;
  if (level === "workspace") return { level: "workspace" };
  if (level !== "crew" && level !== "agent") return null;
  if (typeof ref !== "string" || !ref.trim()) return null;
  return { level, ref: ref.trim() };
}

/**
 * Validate and fill a rule, or say why not.
 *
 * Throws rather than correcting: a rule stored at a window nobody asked for
 * would enforce something other than what the operator read back.
 */
export function normalizePlanRequiredRule(input: PlanRequiredRule, at: string): PlanRequiredRecord {
  const scope = parsePlanRequiredScope(input.scope);
  if (!scope) throw new Error("invalid_plan_required: scope must be workspace | crew | agent");
  if (!isPlanRequiredMode(input.mode)) {
    throw new Error(`invalid_plan_required: mode must be ${PLAN_REQUIRED_MODES.join(" | ")}`);
  }
  const windowMs = input.windowMs ?? PLAN_REQUIRED_DEFAULT_WINDOW_MS;
  if (
    !Number.isFinite(windowMs) ||
    windowMs < PLAN_REQUIRED_MIN_WINDOW_MS ||
    windowMs > PLAN_REQUIRED_MAX_WINDOW_MS
  ) {
    throw new Error(
      `invalid_plan_required: windowMs must be ${PLAN_REQUIRED_MIN_WINDOW_MS}–${PLAN_REQUIRED_MAX_WINDOW_MS}`,
    );
  }
  const minPlanChars = input.minPlanChars ?? PLAN_REQUIRED_DEFAULT_MIN_CHARS;
  if (!Number.isInteger(minPlanChars) || minPlanChars < 1 || minPlanChars > 1_000) {
    throw new Error("invalid_plan_required: minPlanChars must be 1–1000");
  }
  return {
    scope,
    mode: input.mode,
    windowMs,
    minPlanChars,
    acceptUpstreamPlan: input.acceptUpstreamPlan === true,
    at,
  };
}

export const PLAN_REQUIRED_DEFAULT: PlanRequiredSettings = {
  mode: "off",
  windowMs: PLAN_REQUIRED_DEFAULT_WINDOW_MS,
  minPlanChars: PLAN_REQUIRED_DEFAULT_MIN_CHARS,
  acceptUpstreamPlan: false,
};

/**
 * The requirement one principal runs under.
 *
 * Narrowest-first — agent, then the nearest crew, then workspace — for the
 * reason connector modes resolve that way: an operator writes one broad rule
 * and carves out the seats that need something else. Unlike a connector mode,
 * a narrower rule here may *widen* as well as tighten, because this is not
 * authority: the most `off` can do is return a crew to the behaviour it had
 * before anyone turned the mode on, and every onchain and connector control
 * still stands behind it.
 */
export function resolvePlanRequired(
  rules: readonly PlanRequiredRule[],
  subject: PlanRequiredSubject = {},
): PlanRequiredResolution {
  const byKey = new Map<string, PlanRequiredRule>();
  // Last writer wins within a scope, so re-setting a rule replaces it.
  for (const rule of rules) byKey.set(planRequiredScopeKey(rule.scope), rule);

  const settingsOf = (rule: PlanRequiredRule): PlanRequiredResolution => ({
    mode: rule.mode,
    windowMs: rule.windowMs ?? PLAN_REQUIRED_DEFAULT_WINDOW_MS,
    minPlanChars: rule.minPlanChars ?? PLAN_REQUIRED_DEFAULT_MIN_CHARS,
    acceptUpstreamPlan: rule.acceptUpstreamPlan === true,
    source: { kind: "rule", scope: rule.scope },
  });

  const principal = subject.principal ? norm(subject.principal) : undefined;
  if (principal) {
    const own = byKey.get(`agent:${principal}`);
    if (own) return settingsOf(own);
    // A crew rule may name the seat itself — a crew of one is still a crew.
    const asCrew = byKey.get(`crew:${principal}`);
    if (asCrew) return settingsOf(asCrew);
  }
  for (const manager of subject.managers ?? []) {
    const hit = byKey.get(`crew:${norm(manager)}`);
    if (hit) return settingsOf(hit);
  }
  const workspace = byKey.get("workspace");
  return workspace
    ? settingsOf(workspace)
    : { ...PLAN_REQUIRED_DEFAULT, source: { kind: "default" } };
}

/**
 * LaCrew tools that change something, and which tier they belong to.
 *
 * `lacrew_propose_intent` is the money path — the tool a flow's `gate` step
 * calls — so it is the whole of `spends_only`. The org, budget and governance
 * mutators are constitutional changes: they reach the chain but they are not
 * spends, and an operator who asked only for spends to be planned did not ask
 * for a reparent to be.
 *
 * Deliberately absent: `lacrew_approve_intent`. Approving is a *manager*
 * answering something a worker already escalated, and requiring the approver to
 * plan first would stall the escalation path this protocol depends on.
 */
const LACREW_TOOL_EFFECTS: Record<string, PlanRequiredEffect> = {
  lacrew_propose_intent: "spend",
  lacrew_org_action: "write",
  lacrew_set_budget: "write",
  lacrew_governance: "write",
};

/** Whether a tool name is an external surface this package cannot classify alone. */
const CONNECTOR_TOOL = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/;
const EXTERNAL_MCP_TOOL = /^mcp__[a-z0-9][a-z0-9-]*__.+$/;

/**
 * What this call would do, or null when it changes nothing this mode covers.
 *
 * `effectOf` classifies the operator's own surfaces — a connector route or an
 * external MCP tool — because only the registry that holds them knows whether
 * one reads or writes. Absent, they are treated as writes: being wrong in the
 * cautious direction costs a plan nobody needed, and being wrong the other way
 * is the publish this feature exists to catch. A `lacrew_*` name is classified
 * here and never by the lookup, so nothing an operator registers can reclassify
 * the money path.
 */
export function classifyPlanEffect(
  tool: string,
  effectOf?: (tool: string) => "read" | "write" | undefined,
): PlanRequiredEffect | null {
  const name = tool.trim();
  const known = LACREW_TOOL_EFFECTS[name];
  if (known) return known;
  if (name.startsWith("lacrew_")) return null;
  if (CONNECTOR_TOOL.test(name) || EXTERNAL_MCP_TOOL.test(name)) {
    return effectOf?.(name) === "read" ? null : "write";
  }
  return null;
}

/** Whether this mode covers this effect. */
export function planRequiredFor(mode: PlanRequiredMode, effect: PlanRequiredEffect): boolean {
  if (mode === "off") return false;
  if (mode === "spends_only") return effect === "spend";
  return true;
}

/** The subset of a conversation message this module reads. */
export type PlanMessage = {
  id: string;
  threadId: string;
  at: string;
  author: string;
  authorKind: "agent" | "human";
  kind: string;
  body: string;
  refs?: ReadonlyArray<{ kind: string; id: string }>;
};

export type PlanQualification = {
  principal: string;
  /** Threads a plan by this principal may live in. */
  threadIds: readonly string[];
  now: Date;
  windowMs: number;
  minPlanChars: number;
  /** Run being executed; a plan tagged with it counts however old it is. */
  runId?: string;
  /**
   * When the run started, for the freshness floor.
   *
   * A plan that was current when the run began stays current *for that run*.
   * Without this, a pipeline that parked on an ask-mode write or a human gate
   * would come back an hour later and refuse the very step a person had just
   * approved — the requirement and the wait would be mutually exclusive, which
   * is not a trade an operator should have to make.
   */
  runStartedAt?: Date;
  /** Principals that delegated this work, when `acceptUpstreamPlan` is on. */
  upstream?: readonly string[];
};

/** Why no plan qualified — the operator-facing half of a refusal. */
export type PlanRequiredMiss = "none" | "stale";

/**
 * The most recent plan that satisfies the requirement, or why none does.
 *
 * Four things make a plan count, and each of them is a way the control could
 * otherwise be faked:
 *
 *   - **kind `plan`** — a `note` saying "about to merge" is not a plan; the
 *     kinds exist so a reader knows what they are looking at without reading it.
 *   - **authored by the acting principal** — an agent cannot ride another
 *     seat's plan, which is what keeps a busy crew's thread from covering every
 *     member of it. A *human's* plan never counts either: a human writing "we
 *     should ship this" has not made the agent state its intent, and reading it
 *     as one would turn a conversation into authorisation.
 *   - **in a thread that principal speaks in** — a plan posted where nobody
 *     supervising this crew reads it satisfies nothing.
 *   - **fresh, or from this run** — see the note at the top of this file, and
 *     `runStartedAt` for why a run that waited on a human keeps its plan.
 */
export function qualifyingPlan(
  messages: readonly PlanMessage[],
  check: PlanQualification,
): { plan: PlanMessage } | { plan: null; miss: PlanRequiredMiss } {
  const authors = new Set([norm(check.principal), ...(check.upstream ?? []).map(norm)]);
  const threads = new Set(check.threadIds.map(norm));
  // Measured from the run's start when there is one, so a wait inside the run
  // does not age out the plan the run began with.
  const floor = (check.runStartedAt ?? check.now).getTime() - check.windowMs;

  let sawStale = false;
  // Newest first: the current statement of intent is the last one made.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.kind !== "plan") continue;
    if (message.authorKind !== "agent") continue;
    if (!authors.has(norm(message.author))) continue;
    if (!threads.has(norm(message.threadId))) continue;
    if (message.body.trim().length < check.minPlanChars) continue;

    const sameRun =
      check.runId !== undefined &&
      (message.refs ?? []).some((ref) => ref.kind === "flowRun" && ref.id === check.runId);
    if (sameRun) return { plan: message };

    const at = Date.parse(message.at);
    // An unparseable timestamp is not evidence of freshness. Treated as stale
    // rather than skipped, so the refusal says "there is a plan, it is too old"
    // instead of "there is no plan" — different sentences, different fixes.
    if (!Number.isFinite(at) || at < floor) {
      sawStale = true;
      continue;
    }
    return { plan: message };
  }
  return { plan: null, miss: sawStale ? "stale" : "none" };
}

/**
 * Threads a principal's plan may live in.
 *
 * Its own agent thread, the crew threads of every manager above it (a desk
 * plans in the desk's thread), the crew thread named by its own address for a
 * seat that manages nobody, and `org`. Wide on purpose: the requirement is that
 * the agent said it somewhere a supervisor reads, not that it picked the thread
 * this module would have picked.
 */
export function planThreadIds(principal: string, managers: readonly string[] = []): string[] {
  const seat = norm(principal);
  return [
    `agent:${seat}`,
    `crew:${seat}`,
    ...managers.map((manager) => `crew:${norm(manager)}`),
    "org",
  ];
}
