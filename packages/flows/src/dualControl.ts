/**
 * Dual control: a second seat concurs, or the effect does not happen (PRD F2.32).
 *
 * Policy bounds *what* a crew may do and plan-required (F2.31) bounds *when* it
 * may do it without having said so. Neither catches the plan that is simply
 * wrong — a hallucinated venue, a merge target injected through a tool result,
 * a goal that drifted three steps ago. A single agent can plan the thing,
 * propose it and, under cap, execute it, and every control it passed was a
 * control about the agent rather than about the decision.
 *
 * This is the four-eyes rule for that gap: before a matching side effect, the
 * runtime asks a *different* seat — a peer, the manager above, or a human — to
 * concur in the thread, and parks the run until one does. Reject stops the
 * effect. Nobody answering stops it too.
 *
 * ## What a concurrence is not
 *
 *   - **It is not authority over money.** Concurring releases a step the actor
 *     was already permitted to take. It cannot finalize an intent, widen a cap,
 *     or admit a call PolicyModule refused, and a spend behind a concurrence
 *     still meets the stack and still escalates. EscalationRouter and
 *     GovernanceModule remain the only things that decide about the treasury
 *     and the constitution.
 *   - **It is not a quorum of trust.** Two agents on one orchestrator are two
 *     processes with one blast radius: whatever compromised the actor may well
 *     reach the reviewer. Dual control raises the cost of a single injected
 *     prompt; it does not make a crew self-governing, and high-tier treasury
 *     changes still need human governance. The product copy has to say so,
 *     because the failure mode of this feature is an operator reading "two
 *     agents agreed" as "a human checked".
 *   - **It is not the human gate.** F2.27 stops a run at a step the *flow
 *     author* chose. This stops it at an effect the *operator's policy*
 *     matched, wherever in the run it happens, including inside a delegate.
 *
 * ## Why the reviewer is resolved here and never claimed
 *
 * A message's author is attributed server-side when it is posted, so an agent
 * cannot sign a concurrence as its manager. This module never reads an author
 * off the message it is judging — it is handed the set of seats that may
 * concur, computed from the org chart, and the actor is removed from that set
 * first. Self-concurrence is not a rule that can be forgotten: there is no code
 * path where the actor is in the set.
 *
 * The shape, the thresholds and the qualification test live in this pure
 * package so a CLI, an eval and a control plane can answer "would this have
 * needed a second pair of eyes?" without a running orchestrator. The question,
 * the parked run and the audit trail live in `@lacrew/orchestrator`.
 */

/**
 * How much of a crew's behaviour needs a second seat.
 *
 * `off` — nothing.
 * `risky_writes` — the effects that reach past this process and cannot be
 *   recalled: connector and external-MCP writes, and the org / budget /
 *   governance mutators. A merge, a publish, a reparent.
 * `spends_and_writes` — those, plus onchain proposes at or above `minSpend`.
 *   The setting a funded desk wants, since the propose is the one effect whose
 *   damage is denominated.
 */
export type DualControlMode = "off" | "risky_writes" | "spends_and_writes";

export const DUAL_CONTROL_MODES: DualControlMode[] = ["off", "risky_writes", "spends_and_writes"];

export function isDualControlMode(value: unknown): value is DualControlMode {
  return typeof value === "string" && DUAL_CONTROL_MODES.includes(value as DualControlMode);
}

/**
 * Who may concur.
 *
 * `manager` — the nearest available seat above the actor in the org chart,
 *   which is the reviewer most crews mean; when that seat is a human root the
 *   question lands in the Questions rail instead of an agent's thread.
 * `seat:<address>` — one named seat. For a dedicated reviewer agent.
 * `role:human` — a person, always. The strictest setting, and the only one that
 *   does not depend on an agent being honest.
 * `any_peer_in_crew` — any other active seat under the same manager. Cheapest
 *   to satisfy, and worth exactly what a peer's judgement is worth: it catches
 *   the drifted goal and the mis-typed target, not a compromise of the whole
 *   crew.
 */
export type DualControlReviewer =
  { kind: "manager" } | { kind: "seat"; account: string } | { kind: "human" } | { kind: "peer" };

export const DUAL_CONTROL_REVIEWERS = [
  "manager",
  "seat:<address>",
  "role:human",
  "any_peer_in_crew",
];

/** The wire form: `manager` | `seat:0x…` | `role:human` | `any_peer_in_crew`. */
export function formatReviewer(reviewer: DualControlReviewer): string {
  if (reviewer.kind === "manager") return "manager";
  if (reviewer.kind === "human") return "role:human";
  if (reviewer.kind === "peer") return "any_peer_in_crew";
  return `seat:${reviewer.account}`;
}

export function parseReviewer(raw: unknown): DualControlReviewer | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "manager") return { kind: "manager" };
  if (value === "role:human" || value === "human") return { kind: "human" };
  if (value === "any_peer_in_crew" || value === "peer") return { kind: "peer" };
  if (value.startsWith("seat:")) {
    const account = value.slice("seat:".length).trim();
    return account ? { kind: "seat", account } : null;
  }
  return null;
}

/**
 * Which effects inside a mode actually qualify — composable, so an operator can
 * ask for review on the money without asking for it on every label change.
 *
 * `minSpend` is in base units, as a decimal string, because that is what the
 * propose itself carries and a float would round somebody's clip size. `"0"`
 * means every spend.
 */
export type DualControlThreshold = {
  /** Proposes at or above this (base units) qualify. Read only in `spends_and_writes`. */
  minSpend?: string;
  /** Connector and external-MCP writes. On by default wherever writes are covered. */
  connectorWrites?: boolean;
  /** `org` / `budget` / `governance` mutators. On by default wherever writes are covered. */
  orgMutators?: boolean;
};

/** Where a rule applies — the same three levels connector modes and F2.31 use. */
export type DualControlScope =
  { level: "workspace" } | { level: "crew"; ref: string } | { level: "agent"; ref: string };

/**
 * How long a review waits before the effect fails closed.
 *
 * A day, matching the human gate, because the reviewer is often a person and a
 * deadline shorter than a working day fires on people rather than on neglect.
 */
export const DUAL_CONTROL_DEFAULT_TIMEOUT_MS = 24 * 60 * 60_000;
/** Below this a review expires before anyone reads it; above it, a parked run is forgotten. */
export const DUAL_CONTROL_MIN_TIMEOUT_MS = 5 * 60_000;
export const DUAL_CONTROL_MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

export type DualControlRule = {
  scope: DualControlScope;
  mode: DualControlMode;
  reviewer?: DualControlReviewer;
  threshold?: DualControlThreshold;
  /** Deadline in ms. Defaults to `DUAL_CONTROL_DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/**
 * A rule as stored and served: every setting filled in, so a reader never needs
 * this module's defaults to know what a scope enforces. `at` is when an
 * operator last set it.
 */
export type DualControlRecord = {
  scope: DualControlScope;
  mode: DualControlMode;
  reviewer: DualControlReviewer;
  threshold: Required<DualControlThreshold>;
  timeoutMs: number;
  at: string;
};

export type DualControlSettings = {
  mode: DualControlMode;
  reviewer: DualControlReviewer;
  threshold: Required<DualControlThreshold>;
  timeoutMs: number;
};

export type DualControlResolution = DualControlSettings & {
  /** What decided it — so an inherited value is legible in a UI. */
  source: { kind: "default" } | { kind: "rule"; scope: DualControlScope };
};

/** Who is acting, for rule resolution. `managers` arrives nearest-first. */
export type DualControlSubject = {
  principal?: string;
  managers?: Iterable<string>;
};

const norm = (value: string): string => value.trim().toLowerCase();

export function dualControlScopeKey(scope: DualControlScope): string {
  return scope.level === "workspace" ? "workspace" : `${scope.level}:${norm(scope.ref)}`;
}

export function parseDualControlScope(raw: unknown): DualControlScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const level = (raw as { level?: unknown }).level;
  const ref = (raw as { ref?: unknown }).ref;
  if (level === "workspace") return { level: "workspace" };
  if (level !== "crew" && level !== "agent") return null;
  if (typeof ref !== "string" || !ref.trim()) return null;
  return { level, ref: ref.trim() };
}

/** The reviewer a rule that names none gets. */
export const DUAL_CONTROL_DEFAULT_REVIEWER: DualControlReviewer = { kind: "manager" };

export const DUAL_CONTROL_DEFAULT: DualControlSettings = {
  mode: "off",
  reviewer: DUAL_CONTROL_DEFAULT_REVIEWER,
  threshold: { minSpend: "0", connectorWrites: true, orgMutators: true },
  timeoutMs: DUAL_CONTROL_DEFAULT_TIMEOUT_MS,
};

/** A decimal base-units amount, or null when it is not one. */
export function parseBaseUnits(raw: unknown): bigint | null {
  if (typeof raw === "bigint") return raw;
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
}

/**
 * Validate and fill a rule, or say why not.
 *
 * Throws rather than correcting: a rule stored at a threshold nobody asked for
 * would review something other than what the operator read back — and the
 * direction of that mistake is a spend going out unreviewed.
 */
export function normalizeDualControlRule(input: DualControlRule, at: string): DualControlRecord {
  const scope = parseDualControlScope(input.scope);
  if (!scope) throw new Error("invalid_dual_control: scope must be workspace | crew | agent");
  if (!isDualControlMode(input.mode)) {
    throw new Error(`invalid_dual_control: mode must be ${DUAL_CONTROL_MODES.join(" | ")}`);
  }
  const reviewer = input.reviewer ?? DUAL_CONTROL_DEFAULT_REVIEWER;
  if (!parseReviewer(formatReviewer(reviewer))) {
    throw new Error(`invalid_dual_control: reviewer must be ${DUAL_CONTROL_REVIEWERS.join(" | ")}`);
  }
  if (reviewer.kind === "seat" && !/^0x[0-9a-f]{40}$/i.test(reviewer.account.trim())) {
    throw new Error("invalid_dual_control: seat reviewer must be an address");
  }
  const timeoutMs = input.timeoutMs ?? DUAL_CONTROL_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < DUAL_CONTROL_MIN_TIMEOUT_MS ||
    timeoutMs > DUAL_CONTROL_MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `invalid_dual_control: timeoutMs must be ${DUAL_CONTROL_MIN_TIMEOUT_MS}–${DUAL_CONTROL_MAX_TIMEOUT_MS}`,
    );
  }
  const minSpendRaw = input.threshold?.minSpend;
  const minSpend = minSpendRaw === undefined ? 0n : parseBaseUnits(minSpendRaw);
  if (minSpend === null) {
    throw new Error("invalid_dual_control: threshold.minSpend must be base units (decimal string)");
  }
  return {
    scope,
    mode: input.mode,
    reviewer:
      reviewer.kind === "seat" ? { kind: "seat", account: norm(reviewer.account) } : reviewer,
    threshold: {
      minSpend: minSpend.toString(),
      connectorWrites: input.threshold?.connectorWrites !== false,
      orgMutators: input.threshold?.orgMutators !== false,
    },
    timeoutMs,
    at,
  };
}

/**
 * The rule one principal runs under.
 *
 * Narrowest-first — agent, then the nearest crew, then workspace — the same
 * precedence connector modes and plan-required resolve with, so an operator
 * writes one broad rule and carves out the seats that need something else.
 */
export function resolveDualControl(
  rules: readonly DualControlRecord[],
  subject: DualControlSubject = {},
): DualControlResolution {
  const byKey = new Map<string, DualControlRecord>();
  // Last writer wins within a scope, so re-setting a rule replaces it.
  for (const rule of rules) byKey.set(dualControlScopeKey(rule.scope), rule);

  const settingsOf = (rule: DualControlRecord): DualControlResolution => ({
    mode: rule.mode,
    reviewer: rule.reviewer,
    threshold: rule.threshold,
    timeoutMs: rule.timeoutMs,
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
    : { ...DUAL_CONTROL_DEFAULT, source: { kind: "default" } };
}

/**
 * What a call would do, in the categories the thresholds distinguish.
 *
 * `spend` carries the value the propose itself would carry, so a threshold is
 * evaluated against the number that will actually move rather than against
 * anything the caller re-derived.
 */
export type DualControlEffect =
  | { effect: "spend"; value: bigint | null; target?: string }
  | { effect: "write"; surface: "connector" | "org" };

/**
 * LaCrew tools that change something, and which category they fall in.
 *
 * Deliberately absent: `lacrew_approve_intent`. Approving *is* the second pair
 * of eyes — it is a manager answering something a worker escalated — and
 * requiring a review of a review would stall the escalation path this protocol
 * depends on.
 */
const LACREW_TOOL_SURFACES: Record<string, "spend" | "org"> = {
  lacrew_propose_intent: "spend",
  lacrew_org_action: "org",
  lacrew_set_budget: "org",
  lacrew_governance: "org",
};

/** External surfaces this package cannot classify alone — the registry does. */
const CONNECTOR_TOOL = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/;
const EXTERNAL_MCP_TOOL = /^mcp__[a-z0-9][a-z0-9-]*__.+$/;

/**
 * What this call would do, or null when it changes nothing dual control covers.
 *
 * A connector route or an external MCP tool is classified by the registry that
 * holds it, since only that registry knows whether a route reads or writes.
 * Absent, it is treated as a write: being wrong in the cautious direction costs
 * a question nobody needed, and being wrong the other way is the unreviewed
 * publish this feature exists to catch. A `lacrew_*` name is classified here
 * and never by the lookup, so nothing an operator registers can reclassify the
 * money path.
 */
export function classifyDualEffect(
  tool: string,
  args: Record<string, unknown> = {},
  effectOf?: (tool: string) => "read" | "write" | undefined,
): DualControlEffect | null {
  const name = tool.trim();
  const known = LACREW_TOOL_SURFACES[name];
  if (known === "spend") {
    return {
      effect: "spend",
      // Unreadable is null rather than zero: a propose whose value this module
      // cannot parse must not slip under a threshold by looking free.
      value: parseBaseUnits(args.value),
      ...(typeof args.target === "string" ? { target: args.target } : {}),
    };
  }
  if (known === "org") return { effect: "write", surface: "org" };
  if (name.startsWith("lacrew_")) return null;
  if (CONNECTOR_TOOL.test(name) || EXTERNAL_MCP_TOOL.test(name)) {
    return effectOf?.(name) === "read" ? null : { effect: "write", surface: "connector" };
  }
  return null;
}

/** Whether this setting asks for a second seat on this effect. */
export function dualControlRequired(
  settings: Pick<DualControlSettings, "mode" | "threshold">,
  effect: DualControlEffect,
): boolean {
  if (settings.mode === "off") return false;
  if (effect.effect === "spend") {
    if (settings.mode !== "spends_and_writes") return false;
    const floor = parseBaseUnits(settings.threshold.minSpend) ?? 0n;
    // An unreadable value is reviewed whatever the floor: the alternative is a
    // propose escaping review because its amount was malformed.
    if (effect.value === null) return true;
    return effect.value >= floor;
  }
  return effect.surface === "org"
    ? settings.threshold.orgMutators !== false
    : settings.threshold.connectorWrites !== false;
}

/** One seat of the org chart, as reviewer resolution needs to see it. */
export type DualControlSeat = {
  account: string;
  kind: "human_root" | "manager_agent" | "worker_agent";
  parent?: string | null;
  active?: boolean;
  /** Paused seats cannot answer, so they cannot be the reviewer (F2.32 FR3). */
  paused?: boolean;
};

/**
 * The seats whose concurrence releases one effect.
 *
 * `accounts` never contains the actor. That is not a check performed later — it
 * is the only way this value is built, so "an agent cannot concur with itself"
 * holds for every reviewer setting, including a misconfigured `seat:` that
 * names the actor (which escalates to a person instead).
 */
export type ReviewerTarget = {
  /** How the reviewer was found — the audit row and the question's copy read this. */
  via: "manager" | "seat" | "human" | "peer";
  accounts: string[];
  /** Whether those seats are people, which decides where the question is asked. */
  human: boolean;
  /** True when the configured reviewer was unavailable and this is the fallback. */
  escalated: boolean;
  /**
   * Whether a person may concur in place of the configured reviewer.
   *
   * Always true, and stated as a field because it is a product decision rather
   * than an accident: a crew whose reviewer agent is paused, fired or simply
   * wedged must not be a crew whose work is frozen until an operator edits
   * policy. The humans in the chart are the escalation target for everything
   * else in the protocol, and letting them answer here is strictly narrower
   * than the alternative an operator would otherwise reach for, which is
   * turning dual control off.
   *
   * A human answer is recognised by the attribution the conversation made when
   * the message was posted, not by an address: a person's seat in the cloud is
   * an account, not an org node, so the chart cannot say which human this is.
   * What it can say is that an agent did not write it — which is the property
   * four-eyes actually needs.
   */
  humanOverride: boolean;
};

const availableSeat = (seat: DualControlSeat | undefined): boolean =>
  Boolean(seat && seat.active !== false && seat.paused !== true);

/**
 * Who may review this actor's effects.
 *
 * Always somebody: every path that cannot name an agent reviewer escalates to
 * the people rather than resolving to nobody, because "no reviewer" would have
 * to mean either an unreviewed effect or a crew frozen with no way to unfreeze
 * it, and asking a person is better than both.
 */
export function resolveReviewer(
  reviewer: DualControlReviewer,
  actor: string,
  org: readonly DualControlSeat[],
): ReviewerTarget {
  const me = norm(actor);
  const byAccount = new Map(org.map((seat) => [norm(seat.account), seat]));

  /** Ancestors nearest-first, following the chart's parent pointers. */
  const ancestors: DualControlSeat[] = [];
  const seen = new Set<string>([me]);
  let cursor = byAccount.get(me)?.parent ? norm(byAccount.get(me)!.parent!) : undefined;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byAccount.get(cursor);
    if (node) ancestors.push(node);
    cursor = node?.parent ? norm(node.parent) : undefined;
  }
  const humansAbove = ancestors
    .filter((seat) => seat.kind === "human_root" && availableSeat(seat))
    .map((seat) => norm(seat.account));
  // Fallback for a chart the actor is not in (or a flat one): every human root.
  const humansAnywhere =
    humansAbove.length > 0
      ? humansAbove
      : org
          .filter(
            (seat) =>
              seat.kind === "human_root" && availableSeat(seat) && norm(seat.account) !== me,
          )
          .map((seat) => norm(seat.account));
  const humanOverride = true;

  /**
   * Fall back to the people. A chart with no readable human root still asks
   * them — the question goes to the Questions rail, which is where a person
   * would have answered anyway; what an empty list costs is the ability to
   * *name* who owes the answer, not the ability to ask for it.
   */
  const escalate = (via: ReviewerTarget["via"]): ReviewerTarget => ({
    via,
    accounts: humansAnywhere,
    human: true,
    escalated: true,
    humanOverride,
  });

  if (reviewer.kind === "human") {
    return { via: "human", accounts: humansAnywhere, human: true, escalated: false, humanOverride };
  }

  if (reviewer.kind === "seat") {
    const account = norm(reviewer.account);
    // The actor naming itself is a configuration that cannot be satisfied; it
    // escalates rather than silently reviewing nothing.
    if (account === me) return escalate("seat");
    const seat = byAccount.get(account);
    // An unknown seat is honoured on trust rather than escalated: an org tree
    // this process cannot read (mock mode, no registry) would otherwise turn
    // every named reviewer into a human question.
    if (!seat) {
      return { via: "seat", accounts: [account], human: false, escalated: false, humanOverride };
    }
    if (!availableSeat(seat)) return escalate("seat");
    return {
      via: "seat",
      accounts: [account],
      human: seat.kind === "human_root",
      escalated: false,
      humanOverride,
    };
  }

  if (reviewer.kind === "manager") {
    // The nearest *available* ancestor. Walking past a paused manager rather
    // than stopping at it is what keeps a crew working when one seat is out,
    // and every seat further up is a stricter reviewer than the one skipped.
    const manager = ancestors.find((seat) => availableSeat(seat) && norm(seat.account) !== me);
    if (!manager) return escalate("manager");
    const account = norm(manager.account);
    const escalated = norm(ancestors[0]?.account ?? "") !== account;
    return {
      via: manager.kind === "human_root" ? "human" : "manager",
      accounts: [account],
      human: manager.kind === "human_root",
      escalated,
      humanOverride,
    };
  }

  // any_peer_in_crew: seats sharing the actor's manager. A crew of one has no
  // peers, and that is a real answer — it escalates rather than pretending the
  // actor reviewed itself.
  const parent = byAccount.get(me)?.parent ? norm(byAccount.get(me)!.parent!) : undefined;
  const peers = parent
    ? org
        .filter(
          (seat) =>
            seat.parent !== undefined &&
            seat.parent !== null &&
            norm(seat.parent) === parent &&
            norm(seat.account) !== me &&
            availableSeat(seat),
        )
        .map((seat) => norm(seat.account))
    : [];
  if (peers.length === 0) return escalate("peer");
  return { via: "peer", accounts: peers, human: false, escalated: false, humanOverride };
}

/** The two answers a review accepts. Anything else decides nothing. */
export const DUAL_CONTROL_OPTIONS = ["concur", "reject"] as const;

/**
 * Read a reply as a decision, or as nothing.
 *
 * Only the offered words count. "looks fine to me" is a sentence a reviewer
 * means as a yes and a parser can only guess at, and a wrong guess here is an
 * effect nobody agreed to — so free text resolves nothing and the review stays
 * open.
 */
export function readReviewAnswer(body: string): "concurred" | "rejected" | null {
  const normalized = body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  if (normalized === "concur" || normalized === "concurred") return "concurred";
  if (normalized === "reject" || normalized === "rejected") return "rejected";
  return null;
}

/**
 * May this author's answer resolve this review?
 *
 * Two rules, and the first one is the feature:
 *
 *   - **The actor never qualifies.** Checked here as well as being absent from
 *     `accounts`, because this is the invariant the whole control rests on and
 *     it should not depend on one function having built the list correctly.
 *   - **An agent qualifies only as a seat the reviewer spec named.** A person
 *     qualifies whenever the review is addressed to people, and — by the
 *     `humanOverride` decision above — in place of an agent reviewer too. Who
 *     the person is comes from the attribution the conversation made when the
 *     message was posted; a message cannot claim to be human.
 */
export function concurrenceQualifies(
  target: ReviewerTarget,
  message: { author: string; authorKind: "agent" | "human" },
  actor: string,
): boolean {
  const author = norm(message.author);
  if (author === norm(actor)) return false;
  if (message.authorKind === "human") return target.human || target.humanOverride;
  // An agent answering: it has to be one of the seats asked. `accounts` is
  // empty for a review addressed to people, so no agent can resolve one.
  return !target.human && target.accounts.includes(author);
}
