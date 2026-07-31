/**
 * Inference & API cost budgets (PRD F2.28): a bound on what a crew's *model*
 * usage may cost, in the same shape as the bound on what it may spend onchain.
 *
 * ## Why this exists next to the onchain caps, not inside them
 *
 * A spend cap, a whitelist and a streamed allowance bound the money that leaves
 * the treasury. None of them sees a single token of inference. A heartbeat on a
 * frontier model, a flow that loops, or one badly-scoped delegate can burn more
 * of the operator's cash through an API key than the desk's clip size — while
 * every onchain number still reads healthy. This module is the missing bound.
 *
 * Two invariants make that safe to say out loud:
 *
 *   - **A cost budget moves no funds.** It cannot approve, deny or resize an
 *     onchain action, and it is not a PolicyModule. Exhausting it stops model
 *     calls; a proposal made without a model still goes through.
 *   - **Numbers shown are numbers enforced.** The counters a UI renders are the
 *     counters the guard reads. When a provider returns no price, the call is
 *     counted as *unpriced* rather than priced at zero — a dollar figure that
 *     quietly omits calls is worse than one labelled incomplete.
 *
 * ## Why this module holds no orchestrator
 *
 * Shape, period math and "how close is this to the line?" are pure, so a CLI
 * can check a budget and a control plane can reject a bad one without booting a
 * runtime. Metering, storage and refusal live in `@lacrew/orchestrator`, at
 * `ModelProvider.complete` — the one place every vendor's calls pass through.
 */

/**
 * The window usage accumulates in before it resets.
 *
 * `calendar_month` — UTC calendar month. What a card statement looks like.
 * `epoch` — aligned to the org's payroll epoch, so inference and allowances
 *   roll over together. Length and anchor are configured, mirroring the
 *   streamer's; this module never reads a chain.
 * `window` — a **tumbling** window of `windowDays`, anchored at `anchorAt`.
 *   Deliberately not a trailing "last 30 days": the enforced number is a
 *   counter per period key, and a trailing window would make the figure an
 *   operator sees drift under them between two page loads with no event.
 */
export type InferenceBudgetPeriod = "calendar_month" | "epoch" | "window";

/**
 * What a breach does.
 *
 * `soft` — warn and keep going. The crew stays useful; a human decides.
 * `hard` — refuse further completions with `inference_budget_exceeded`. Fails
 *   closed by construction: the guard refuses when it cannot read usage, since
 *   an unreadable ledger is exactly the state a runaway loop produces.
 */
export type InferenceBudgetPolicy = "soft" | "hard";

/**
 * Any subset. An unset limit is not "unlimited by mistake" — it is a dimension
 * the operator chose not to bound, and it never contributes to the status.
 */
export type InferenceBudgetLimits = {
  /** Dollars for the period. Best-effort: see `priceCompletion`. */
  maxUsd?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
};

export type InferenceBudget = {
  /** Crew this bounds. Lowercased; also the thread its alerts land in. */
  crewId: string;
  /**
   * Narrows the budget to one seat. Precedence: an agent's calls are charged
   * to **both** its own budget and its crew's, and the effective allowance is
   * the smaller remaining of the two — so an agent cap can only ever tighten
   * the crew cap, never widen it.
   */
  agentId?: string;
  period: InferenceBudgetPeriod;
  /** `window` only: 1–90 days. */
  windowDays?: number;
  /** `epoch` only: epoch length in seconds, mirroring the streamer's. */
  epochSeconds?: number;
  /** `epoch` / `window`: ISO instant period boundaries are counted from. */
  anchorAt?: string;
  limits: InferenceBudgetLimits;
  policy: InferenceBudgetPolicy;
  /**
   * Model to fall back to once usage passes the warn line. The cheapest way to
   * stay alive near the cap is to stop asking the expensive model; a crew that
   * degrades is worth more than one that stops.
   */
  cheapModel?: string;
  /**
   * On a **hard** breach, also stop the crew's heartbeat.
   *
   * A hard breach already refuses completions. Without this the heartbeat keeps
   * waking on its cadence and keeps being refused, which fills the crew thread
   * with failures nobody can act on. Stopping the timer is the narrow fix; the
   * agent itself stays live, so a human in a thread is not locked out of the
   * crew because a scheduled sweep ran the budget down. Ignored under `soft`,
   * which blocks nothing by definition.
   */
  pauseHeartbeatOnBreach: boolean;
  enabled: boolean;
  updatedAt: string;
};

/** Usage inside one period. Counters only — no rates, no projections. */
export type InferenceUsage = {
  inputTokens: number;
  outputTokens: number;
  /**
   * Micro-dollars, as an integer. A crew makes millions of sub-cent calls, and
   * accumulating those as floats loses money in the direction that under-bills.
   */
  usdMicros: number;
  calls: number;
  /**
   * Calls whose cost could not be priced. This is why a `$` figure may read
   * low, and it is carried everywhere the figure is, rather than dropped.
   */
  unpricedCalls: number;
};

export const ZERO_USAGE: InferenceUsage = {
  inputTokens: 0,
  outputTokens: 0,
  usdMicros: 0,
  calls: 0,
  unpricedCalls: 0,
};

/** The stable error code a refused completion reports to flows, MCP and HTTP. */
export const INFERENCE_BUDGET_EXCEEDED = "inference_budget_exceeded";

/**
 * Thrown by the guard when a hard budget is out of room.
 *
 * Carries the scope and the dimension that ran out, because "which budget, and
 * which of its three numbers?" is the entire content of the operator's next
 * question.
 */
export class InferenceBudgetExceededError extends Error {
  readonly code = INFERENCE_BUDGET_EXCEEDED;
  constructor(
    readonly scopeKey: string,
    readonly dimension: InferenceBudgetDimension,
    readonly periodKey: string,
  ) {
    super(`${INFERENCE_BUDGET_EXCEEDED}: ${scopeKey} over ${dimension} for ${periodKey}`);
    this.name = "InferenceBudgetExceededError";
  }
}

export function isInferenceBudgetExceeded(error: unknown): error is InferenceBudgetExceededError {
  return error instanceof InferenceBudgetExceededError;
}

export type InferenceBudgetDimension = "usd" | "inputTokens" | "outputTokens";

/** Fraction of a limit at which an alert fires while there is still room to act. */
export const INFERENCE_BUDGET_WARN_RATIO = 0.8;

/** Longest `window` period. Past a quarter, a budget stops being a budget. */
export const INFERENCE_BUDGET_MAX_WINDOW_DAYS = 90;

const trimmed = (value: string | undefined): string => (value ?? "").trim();

/**
 * Identity of a metered subject. `crew:<id>` or `crew:<id>/agent:<0x…>` — the
 * agent form nests under the crew so a store listing is readable, and so the
 * two rows an agent's call touches are visibly related.
 */
export function budgetScopeKey(subject: { crewId: string; agentId?: string }): string {
  const crew = `crew:${trimmed(subject.crewId).toLowerCase()}`;
  const agent = trimmed(subject.agentId).toLowerCase();
  return agent ? `${crew}/agent:${agent}` : crew;
}

export type InferenceBudgetValidation = { ok: boolean; errors: string[] };

/**
 * Shape-check a budget. Whether the crew or agent exists is *not* checked here
 * — only the live process knows that, and it refuses at save time.
 */
export function validateInferenceBudget(budget: InferenceBudget): InferenceBudgetValidation {
  const errors: string[] = [];
  if (!trimmed(budget.crewId)) errors.push("crewId is required");
  if (budget.agentId !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(trimmed(budget.agentId))) {
    errors.push("agentId must be a 0x address");
  }
  if (!["calendar_month", "epoch", "window"].includes(budget.period)) {
    errors.push(`unknown period "${budget.period}" (calendar_month | epoch | window)`);
  }
  if (budget.policy !== "soft" && budget.policy !== "hard") {
    errors.push(`unknown policy "${budget.policy}" (soft | hard)`);
  }

  if (budget.period === "window") {
    const days = budget.windowDays ?? 0;
    if (!Number.isInteger(days) || days < 1 || days > INFERENCE_BUDGET_MAX_WINDOW_DAYS) {
      errors.push(`windowDays must be an integer 1–${INFERENCE_BUDGET_MAX_WINDOW_DAYS}`);
    }
  }
  if (budget.period === "epoch") {
    const seconds = budget.epochSeconds ?? 0;
    if (!Number.isInteger(seconds) || seconds < 60) {
      errors.push("epochSeconds must be an integer of at least 60");
    }
  }
  if (budget.anchorAt !== undefined && Number.isNaN(Date.parse(budget.anchorAt))) {
    errors.push("anchorAt must be an ISO instant");
  }

  const limits = budget.limits ?? {};
  for (const key of ["maxUsd", "maxInputTokens", "maxOutputTokens"] as const) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) errors.push(`${key} must be a positive number`);
    if (key !== "maxUsd" && value !== undefined && !Number.isInteger(value)) {
      errors.push(`${key} must be a whole number of tokens`);
    }
  }
  // Refused only when enabled, so an operator can save a half-filled form. An
  // *enabled* budget with no limit is the dangerous one: it reads as protection
  // on every surface and bounds nothing.
  if (budget.enabled && limitDimensions(limits).length === 0) {
    errors.push("an enabled budget needs at least one of maxUsd, maxInputTokens, maxOutputTokens");
  }

  return { ok: errors.length === 0, errors };
}

/** Which dimensions this budget actually bounds. */
export function limitDimensions(limits: InferenceBudgetLimits): InferenceBudgetDimension[] {
  const out: InferenceBudgetDimension[] = [];
  if (limits.maxUsd !== undefined) out.push("usd");
  if (limits.maxInputTokens !== undefined) out.push("inputTokens");
  if (limits.maxOutputTokens !== undefined) out.push("outputTokens");
  return out;
}

/**
 * Canonical form of a caller-supplied budget. Throws on anything
 * `validateInferenceBudget` refuses — storing a half-normalized budget would
 * mean enforcing a limit nobody typed.
 */
export function normalizeInferenceBudget(
  input: Partial<InferenceBudget> & { crewId: string },
  at = new Date().toISOString(),
): InferenceBudget {
  const rawLimits = input.limits ?? {};
  const limits: InferenceBudgetLimits = {
    ...(rawLimits.maxUsd !== undefined ? { maxUsd: rawLimits.maxUsd } : {}),
    ...(rawLimits.maxInputTokens !== undefined
      ? { maxInputTokens: rawLimits.maxInputTokens }
      : {}),
    ...(rawLimits.maxOutputTokens !== undefined
      ? { maxOutputTokens: rawLimits.maxOutputTokens }
      : {}),
  };
  const period = (input.period ?? "calendar_month") as InferenceBudgetPeriod;
  const budget: InferenceBudget = {
    crewId: trimmed(input.crewId).toLowerCase(),
    ...(trimmed(input.agentId) ? { agentId: trimmed(input.agentId).toLowerCase() } : {}),
    period,
    ...(period === "window" ? { windowDays: input.windowDays ?? 30 } : {}),
    ...(period === "epoch" ? { epochSeconds: input.epochSeconds ?? 7 * 86_400 } : {}),
    ...(period !== "calendar_month"
      ? { anchorAt: trimmed(input.anchorAt) || EPOCH_ANCHOR_DEFAULT }
      : {}),
    limits,
    policy: input.policy ?? "soft",
    ...(trimmed(input.cheapModel) ? { cheapModel: trimmed(input.cheapModel) } : {}),
    pauseHeartbeatOnBreach: input.pauseHeartbeatOnBreach ?? true,
    enabled: input.enabled ?? false,
    updatedAt: at,
  };
  const check = validateInferenceBudget(budget);
  if (!check.ok) throw new Error(`invalid_inference_budget: ${check.errors.join("; ")}`);
  return budget;
}

/**
 * Default anchor for periods that count from one: the Unix epoch, so two
 * orchestrators that were never told an anchor still agree on where a window
 * starts. Boot time would make the boundary a property of the last restart.
 */
const EPOCH_ANCHOR_DEFAULT = "1970-01-01T00:00:00.000Z";

export type InferenceBudgetPeriodRange = {
  /** Stable id of this window; the row usage accumulates into. */
  key: string;
  startsAt: string;
  endsAt: string;
};

/**
 * The window `now` falls in.
 *
 * Rollover is this function and nothing else: a new key means a fresh counter,
 * so a period boundary needs no sweep, no job and no migration — the next call
 * simply writes somewhere new. That is also why a mid-period cap increase takes
 * effect immediately: the counter it is compared against did not move.
 */
export function budgetPeriod(budget: InferenceBudget, now: Date): InferenceBudgetPeriodRange {
  if (budget.period === "calendar_month") {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const startsAt = new Date(Date.UTC(year, month, 1));
    const endsAt = new Date(Date.UTC(year, month + 1, 1));
    return {
      key: `${year}-${String(month + 1).padStart(2, "0")}`,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    };
  }

  const lengthMs =
    budget.period === "epoch"
      ? (budget.epochSeconds ?? 7 * 86_400) * 1_000
      : (budget.windowDays ?? 30) * 86_400_000;
  const anchor = Date.parse(budget.anchorAt ?? EPOCH_ANCHOR_DEFAULT);
  // `floor` rather than truncation: an anchor in the future is a config an
  // operator can type, and negative indices still tile the line evenly.
  const index = Math.floor((now.getTime() - anchor) / lengthMs);
  const startsAt = new Date(anchor + index * lengthMs);
  const endsAt = new Date(anchor + (index + 1) * lengthMs);
  return {
    key: `${budget.period}:${lengthMs}:${index}`,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

export type InferenceBudgetState = "ok" | "warning" | "exceeded";

export type InferenceBudgetStatus = {
  state: InferenceBudgetState;
  /** Highest fraction of any bounded dimension. 0 when nothing is bounded. */
  ratio: number;
  /** The dimension that produced `ratio`, or null when nothing is bounded. */
  worst: InferenceBudgetDimension | null;
  usage: InferenceUsage;
  limits: InferenceBudgetLimits;
  /** Headroom per bounded dimension. USD in dollars, tokens in tokens. */
  remaining: { usd?: number; inputTokens?: number; outputTokens?: number };
  /**
   * True when a USD limit is enforced but some calls in this period could not
   * be priced. The enforced dollar figure is then a floor, and every surface
   * that shows it has to say so.
   */
  usdIncomplete: boolean;
};

/**
 * How this budget stands. Pure, so the guard, the HTTP surface and the UI all
 * derive the same three words from the same two inputs.
 */
export function budgetStatus(
  limits: InferenceBudgetLimits,
  usage: InferenceUsage,
): InferenceBudgetStatus {
  const usedUsd = usage.usdMicros / 1_000_000;
  const pairs: Array<[InferenceBudgetDimension, number, number]> = [];
  if (limits.maxUsd !== undefined) pairs.push(["usd", usedUsd, limits.maxUsd]);
  if (limits.maxInputTokens !== undefined) {
    pairs.push(["inputTokens", usage.inputTokens, limits.maxInputTokens]);
  }
  if (limits.maxOutputTokens !== undefined) {
    pairs.push(["outputTokens", usage.outputTokens, limits.maxOutputTokens]);
  }

  let ratio = 0;
  let worst: InferenceBudgetDimension | null = null;
  for (const [dimension, used, limit] of pairs) {
    const value = limit > 0 ? used / limit : 0;
    if (worst === null || value > ratio) {
      ratio = value;
      worst = dimension;
    }
  }

  const state: InferenceBudgetState =
    ratio >= 1 ? "exceeded" : ratio >= INFERENCE_BUDGET_WARN_RATIO ? "warning" : "ok";

  return {
    state,
    ratio,
    worst,
    usage,
    limits,
    remaining: {
      ...(limits.maxUsd !== undefined ? { usd: Math.max(0, limits.maxUsd - usedUsd) } : {}),
      ...(limits.maxInputTokens !== undefined
        ? { inputTokens: Math.max(0, limits.maxInputTokens - usage.inputTokens) }
        : {}),
      ...(limits.maxOutputTokens !== undefined
        ? { outputTokens: Math.max(0, limits.maxOutputTokens - usage.outputTokens) }
        : {}),
    },
    usdIncomplete: limits.maxUsd !== undefined && usage.unpricedCalls > 0,
  };
}

/**
 * Whether a threshold was crossed between two states, so an alert fires once
 * per crossing rather than on every call above the line. A crew at 81% of its
 * budget generates a completion every few seconds; without this it would
 * generate an alert every few seconds too, and the one that mattered would be
 * the one nobody read.
 */
export function budgetAlertCrossing(
  before: InferenceBudgetState,
  after: InferenceBudgetState,
): InferenceBudgetState | null {
  const rank: Record<InferenceBudgetState, number> = { ok: 0, warning: 1, exceeded: 2 };
  return rank[after] > rank[before] ? after : null;
}

/** Per-million-token list price for one model, in dollars. */
export type ModelPrice = { inputPerMTok: number; outputPerMTok: number };

/**
 * Best-effort list prices, matched by longest name prefix.
 *
 * These are published list prices, not a contract: vendors change them, and a
 * deployment on negotiated rates pays something else entirely. They exist so a
 * `maxUsd` is useful the first time an operator sets one — every deployment
 * that cares about the exact figure overrides them (`LACREW_MODEL_PRICES`), and
 * anything not matched here is counted as **unpriced** rather than free.
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
};

/**
 * Longest-prefix match, after stripping a vendor route prefix (`anthropic/…`)
 * and a trailing date stamp. `claude-opus-5-20260101` and
 * `anthropic/claude-opus-5` are the same product at the same price, and an
 * operator should not have to enumerate every dated snapshot to bound it.
 */
export function lookupModelPrice(
  model: string,
  table: Record<string, ModelPrice> = DEFAULT_MODEL_PRICES,
): ModelPrice | null {
  const name = trimmed(model).toLowerCase().split("/").pop() ?? "";
  if (!name) return null;
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(table)) {
    const candidate = key.toLowerCase();
    if (!name.startsWith(candidate)) continue;
    if (!best || candidate.length > best.key.length) best = { key: candidate, price };
  }
  return best?.price ?? null;
}

/**
 * Rough token count for a string, used only when a provider returns no usage
 * at all. Four characters per token is the standard approximation; it is close
 * enough to keep a token ceiling meaningful and is always marked `estimated`,
 * so nothing downstream can mistake it for a metered number.
 */
export function estimateTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export type PricedCompletion = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Integer micro-dollars, or null when this call could not be priced. */
  usdMicros: number | null;
  /** Where the tokens came from: metered by the provider, or approximated. */
  tokensEstimated: boolean;
  /** Where the price came from. `none` means it is not in the dollar figure. */
  priceSource: "provider" | "table" | "none";
};

/**
 * Turn one completion into the numbers the ledger stores.
 *
 * A provider-reported cost always wins over the table: it is the amount that
 * will actually appear on the bill. When neither the provider nor the table can
 * price the call, `usdMicros` is null — the call still counts against token
 * limits and still increments `unpricedCalls`, and it never silently costs $0.
 */
export function priceCompletion(input: {
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Cost the provider itself reported, in dollars, when it reports one. */
  usd?: number;
  /** Text put in / got back, for the fallback token count. */
  promptText?: string;
  completionText?: string;
  prices?: Record<string, ModelPrice>;
}): PricedCompletion {
  const metered =
    input.usage?.promptTokens !== undefined || input.usage?.completionTokens !== undefined;
  const inputTokens = metered
    ? Math.max(0, Math.round(input.usage?.promptTokens ?? 0))
    : estimateTokens(input.promptText);
  const outputTokens = metered
    ? Math.max(0, Math.round(input.usage?.completionTokens ?? 0))
    : estimateTokens(input.completionText);

  if (input.usd !== undefined && Number.isFinite(input.usd)) {
    return {
      model: input.model,
      inputTokens,
      outputTokens,
      usdMicros: Math.round(input.usd * 1_000_000),
      tokensEstimated: !metered,
      priceSource: "provider",
    };
  }

  const price = lookupModelPrice(input.model, input.prices);
  if (!price) {
    return {
      model: input.model,
      inputTokens,
      outputTokens,
      usdMicros: null,
      tokensEstimated: !metered,
      priceSource: "none",
    };
  }
  // `$/Mtok × tokens` is already micro-dollars: dollars = tokens / 1e6 × price,
  // and micro-dollars multiplies that back by 1e6. No division, so a 12-token
  // call on a $0.15/Mtok model rounds once rather than twice.
  const usdMicros = Math.round(
    inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok,
  );
  return {
    model: input.model,
    inputTokens,
    outputTokens,
    usdMicros,
    tokensEstimated: !metered,
    priceSource: "table",
  };
}

/** Fold one priced call into a period's counters. */
export function addUsage(usage: InferenceUsage, call: PricedCompletion): InferenceUsage {
  return {
    inputTokens: usage.inputTokens + call.inputTokens,
    outputTokens: usage.outputTokens + call.outputTokens,
    usdMicros: usage.usdMicros + (call.usdMicros ?? 0),
    calls: usage.calls + 1,
    unpricedCalls: usage.unpricedCalls + (call.usdMicros === null ? 1 : 0),
  };
}

/**
 * Parse an operator-supplied price table (`LACREW_MODEL_PRICES`).
 *
 * A malformed table returns null rather than a partial one: falling back to the
 * shipped defaults is a knowable state, while silently honouring three of five
 * overrides enforces a number nobody wrote.
 */
export function parseModelPrices(json: string | undefined): Record<string, ModelPrice> | null {
  const raw = trimmed(json);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, ModelPrice> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const price = value as Partial<ModelPrice>;
      if (typeof price?.inputPerMTok !== "number" || typeof price?.outputPerMTok !== "number") {
        return null;
      }
      if (price.inputPerMTok < 0 || price.outputPerMTok < 0) return null;
      out[key] = { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok };
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
