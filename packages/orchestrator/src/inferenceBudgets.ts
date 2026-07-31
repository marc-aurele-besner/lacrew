/**
 * Inference & API cost budgets, in the live process (PRD F2.28).
 *
 * `@lacrew/flows` owns what a budget *is* — the shape, the period math, how
 * close a set of counters is to a limit — so a CLI or a control plane can check
 * one without a running orchestrator. This module owns the parts that need the
 * process: the stored counters, the refusal, the alert, and the model a crew
 * should be using right now given where it stands.
 *
 * ## What a budget may and may not do
 *
 * It refuses model calls. That is the whole of its authority. It cannot approve
 * or deny an onchain action, cannot resize an allowance, and is not a
 * PolicyModule — a crew that has burned its inference budget can still propose
 * a spend, and that spend is still judged by the policy stack exactly as
 * before. Anything else would make an operational cost control into an
 * enforcement surface, and enforcement lives on the chain.
 *
 * ## Precedence, when a crew and a seat are both bounded
 *
 * A seat's call is charged to **both** its own budget and its crew's, and both
 * are checked. So an agent budget can only ever tighten the crew budget, never
 * widen it: an agent with $50 left inside a crew with $2 left has $2. This is
 * the only sane reading — the alternative lets an operator hand out per-agent
 * budgets that sum past the crew cap and quietly overspend it.
 *
 * ## Failing closed
 *
 * A hard budget whose counters cannot be read refuses the call. An unreadable
 * ledger is exactly the state a runaway loop produces, and "we could not tell,
 * so we kept spending" is the failure this feature exists to prevent. A *soft*
 * budget never refuses anything, including in that case.
 */

import {
  INFERENCE_BUDGET_WARN_RATIO,
  InferenceBudgetExceededError,
  ZERO_USAGE,
  budgetAlertCrossing,
  budgetPeriod,
  budgetScopeKey,
  budgetStatus,
  limitDimensions,
  normalizeInferenceBudget,
  type InferenceBudget,
  type InferenceBudgetDimension,
  type InferenceBudgetPeriodRange,
  type InferenceBudgetState,
  type InferenceBudgetStatus,
  type InferenceUsage,
  type PricedCompletion,
} from "@lacrew/flows";
import type { ProtocolEvent } from "@lacrew/core";
import {
  createInferenceBudgetStoreFromEnv,
  type InferenceBudgetStore,
  type InferenceUsageEvent,
} from "./inferenceBudgetStore.js";

/**
 * Crew a model call is charged to when it names none.
 *
 * Not "unmetered". A call nobody attributed still costs money, and dropping it
 * would make the total an operator reads lower than the bill they pay. It lands
 * in one visible bucket that can be budgeted like any other, so the hole is
 * something an operator can see and close rather than something the numbers
 * hide.
 */
export const UNATTRIBUTED_CREW_ID = "unattributed";

/** Who a completion is for. Everything is optional; nothing goes uncounted. */
export type BudgetSubject = {
  crewId?: string;
  agentId?: string;
};

/**
 * The crew a seat belongs to: its nearest manager, or itself when it has none.
 *
 * The same reading connector write policy uses (`connectorPolicy.ts`), and for
 * the same reason — a desk is the manager plus what reports to it, so budgeting
 * "the trading crew" means budgeting everything under the trading manager. A
 * seat with no manager *is* a crew of one, and giving it its own bucket is more
 * honest than folding it into a root that budgets the whole org.
 *
 * `managers` arrives nearest-first, as `ancestorsOf` walks upward.
 */
export function crewIdForSeat(principal: string, managers: readonly string[] = []): string {
  return (managers[0] ?? principal).trim().toLowerCase();
}

export type InferenceBudgetView = {
  scopeKey: string;
  budget: InferenceBudget;
  period: InferenceBudgetPeriodRange;
  status: InferenceBudgetStatus;
};

/** Why a call was refused, or would be. */
export type InferenceBudgetBlock = {
  scopeKey: string;
  dimension: InferenceBudgetDimension;
  periodKey: string;
};

export type InferenceBudgetsSurface = {
  list(): Promise<InferenceBudgetView[]>;
  get(subject: BudgetSubject): Promise<InferenceBudgetView | null>;
  /** Validate and store. Returns the canonical form that was written. */
  save(input: Partial<InferenceBudget> & { crewId: string }): Promise<InferenceBudget>;
  setEnabled(subject: BudgetSubject, enabled: boolean): Promise<InferenceBudget>;
  remove(subject: BudgetSubject): Promise<boolean>;
  /**
   * Refuse now, before anything is spent. Throws `InferenceBudgetExceededError`
   * when a hard budget covering this subject is out of room.
   */
  check(subject: BudgetSubject): Promise<void>;
  /** Same question, answered rather than thrown — for surfaces and heartbeats. */
  blockedBy(subject: BudgetSubject): Promise<InferenceBudgetBlock | null>;
  /** Fold one completed call into every budget that covers it. */
  record(
    subject: BudgetSubject,
    call: PricedCompletion & { provider?: string; runId?: string; flowId?: string },
  ): Promise<void>;
  /**
   * The model this subject should be using right now. Returns `requested`
   * unless a covering budget is past its warn line and names a cheaper one.
   */
  modelFor(subject: BudgetSubject, requested?: string): Promise<string | undefined>;
  /** Whether a hard breach has stopped this crew's heartbeat. */
  heartbeatBlock(crewId: string): Promise<InferenceBudgetBlock | null>;
  /** Per-call breakdown: model, tokens, estimated USD, run ids. */
  events(subject: BudgetSubject, limit?: number): Promise<InferenceUsageEvent[]>;
  /**
   * Metered calls inside an arbitrary window, for the scopes named — the read a
   * period report (F2.33) folds, as opposed to `events`, which answers for the
   * budget's own current period.
   */
  usageBetween(input: {
    scopeKeys: readonly string[];
    fromIso: string;
    toIso: string;
    limit?: number;
  }): Promise<{ events: InferenceUsageEvent[]; complete: boolean }>;
  hydrate(): Promise<number>;
  prune(): Promise<void>;
  storeName: string;
};

const trimmed = (value: string | undefined): string => (value ?? "").trim();

/** Scope keys a call touches, crew first — the wider bound is reported first. */
function scopeKeysFor(subject: BudgetSubject): string[] {
  const crewId = trimmed(subject.crewId).toLowerCase() || UNATTRIBUTED_CREW_ID;
  const agentId = trimmed(subject.agentId).toLowerCase();
  const keys = [budgetScopeKey({ crewId })];
  if (agentId) keys.push(budgetScopeKey({ crewId, agentId }));
  return keys;
}

export function createInferenceBudgets(opts: {
  store?: InferenceBudgetStore;
  /** Posts the warning into the crew's thread. */
  postNote?: (input: { crewId: string; body: string }) => void;
  onEvent?: (event: ProtocolEvent) => void;
  now?: () => Date;
}): InferenceBudgetsSurface {
  const store = opts.store ?? createInferenceBudgetStoreFromEnv();
  const now = opts.now ?? (() => new Date());

  /**
   * Read a budget through the store rather than from a boot map. Replicas
   * share a queue but not memory, so a budget written after this worker booted
   * would otherwise never bind it — and "the limit exists but that box never
   * heard about it" is indistinguishable from no limit at all.
   */
  const budgetFor = async (scopeKey: string): Promise<InferenceBudget | null> => {
    const budget = await store.get(scopeKey);
    return budget?.enabled ? budget : null;
  };

  const viewOf = async (budget: InferenceBudget): Promise<InferenceBudgetView> => {
    const scopeKey = budgetScopeKey(budget);
    const period = budgetPeriod(budget, now());
    const usage = await store.usage(scopeKey, period.key);
    return { scopeKey, budget, period, status: budgetStatus(budget.limits, usage) };
  };

  /**
   * Every enabled budget covering this subject, with its current standing.
   *
   * A read that throws is not swallowed: the caller decides what an unknown
   * budget means, and for a hard one the answer is to refuse.
   */
  const coveringViews = async (subject: BudgetSubject): Promise<InferenceBudgetView[]> => {
    const views: InferenceBudgetView[] = [];
    for (const scopeKey of scopeKeysFor(subject)) {
      const budget = await budgetFor(scopeKey);
      if (budget) views.push(await viewOf(budget));
    }
    return views;
  };

  const blockOf = (view: InferenceBudgetView): InferenceBudgetBlock | null => {
    if (view.budget.policy !== "hard") return null;
    if (view.status.state !== "exceeded") return null;
    return {
      scopeKey: view.scopeKey,
      dimension: view.status.worst ?? "usd",
      periodKey: view.period.key,
    };
  };

  /**
   * The first hard budget standing in this subject's way, or null.
   *
   * A store read that fails propagates rather than answering "not blocked".
   * That is how this fails closed: the caller is a guard in front of a paid
   * call, and an unreadable ledger is exactly the state a runaway loop
   * produces. It surfaces as the store's own error, not as a budget breach —
   * "the database is down" and "you are out of money" need different fixes.
   */
  const blockedBy = async (subject: BudgetSubject): Promise<InferenceBudgetBlock | null> => {
    for (const view of await coveringViews(subject)) {
      const block = blockOf(view);
      if (block) return block;
    }
    return null;
  };

  /**
   * Alert on a crossing, once.
   *
   * The claim is what makes it once: a crew at 81% of its budget produces a
   * completion every few seconds, and without the claim it would produce an
   * alert every few seconds too. A state that fell back — a raised cap, a new
   * period — is recorded silently, so the *next* crossing alerts again.
   */
  const announce = async (
    view: InferenceBudgetView,
    previouslyAlerted: InferenceBudgetState,
  ): Promise<void> => {
    const state = view.status.state;
    const crossing = budgetAlertCrossing(previouslyAlerted, state);
    if (!crossing) {
      if (state !== previouslyAlerted) {
        await store.claimAlert({
          scopeKey: view.scopeKey,
          periodKey: view.period.key,
          from: previouslyAlerted,
          to: state,
        });
      }
      return;
    }
    const mine = await store.claimAlert({
      scopeKey: view.scopeKey,
      periodKey: view.period.key,
      from: previouslyAlerted,
      to: crossing,
    });
    if (!mine) return;

    const pct = Math.round(view.status.ratio * 100);
    const dimension = view.status.worst ?? "usd";
    const qualifier = view.status.usdIncomplete
      ? ` (${view.status.usage.unpricedCalls} call(s) had no known price, so the $ figure is a floor)`
      : "";
    const body =
      crossing === "exceeded"
        ? `INFERENCE_BUDGET_EXCEEDED — ${view.scopeKey} is at ${pct}% of its ${dimension} budget for ${view.period.key}. ` +
          (view.budget.policy === "hard"
            ? "Further model calls are refused until the cap is raised or the period rolls."
            : "This is a soft budget: nothing is blocked.") +
          " This does not affect onchain spending, which its policy stack bounds separately." +
          qualifier
        : `INFERENCE_BUDGET_WARNING — ${view.scopeKey} is at ${pct}% of its ${dimension} budget for ${view.period.key}.` +
          qualifier;

    opts.postNote?.({ crewId: view.budget.crewId, body });
    opts.onEvent?.({
      type: crossing === "exceeded" ? "InferenceBudgetExceeded" : "InferenceBudgetWarned",
      at: now().toISOString(),
      payload: {
        scopeKey: view.scopeKey,
        crewId: view.budget.crewId,
        ...(view.budget.agentId ? { agentId: view.budget.agentId } : {}),
        periodKey: view.period.key,
        policy: view.budget.policy,
        dimension,
        // Percentages and counters, never the prompts behind them.
        ratio: Number(view.status.ratio.toFixed(4)),
        calls: view.status.usage.calls,
        unpricedCalls: view.status.usage.unpricedCalls,
      },
    });
  };

  const subjectOf = (budget: InferenceBudget): BudgetSubject => ({
    crewId: budget.crewId,
    ...(budget.agentId ? { agentId: budget.agentId } : {}),
  });

  return {
    storeName: store.name,

    list: async () => {
      const budgets = await store.list();
      return Promise.all(budgets.map(viewOf));
    },

    get: async (subject) => {
      const keys = scopeKeysFor(subject);
      // The narrowest key the caller named: asking for an agent means the
      // agent's own budget, not the crew budget it also happens to sit under.
      const scopeKey = keys[keys.length - 1]!;
      const budget = await store.get(scopeKey);
      return budget ? viewOf(budget) : null;
    },

    save: async (input) => {
      const budget = normalizeInferenceBudget(input, now().toISOString());
      await store.save(budget);
      return budget;
    },

    setEnabled: async (subject, enabled) => {
      const keys = scopeKeysFor(subject);
      const scopeKey = keys[keys.length - 1]!;
      const existing = await store.get(scopeKey);
      if (!existing) throw new Error(`unknown_inference_budget: ${scopeKey}`);
      // Through the normalizer: enabling a budget that bounds nothing is the
      // one transition that has to be refused, and refusing it here is why a
      // toggle cannot produce a limit that protects nothing.
      const budget = normalizeInferenceBudget({ ...existing, enabled }, now().toISOString());
      await store.save(budget);
      return budget;
    },

    remove: async (subject) => {
      const keys = scopeKeysFor(subject);
      const scopeKey = keys[keys.length - 1]!;
      const existing = await store.get(scopeKey);
      if (!existing) return false;
      await store.remove(scopeKey);
      return true;
    },

    blockedBy,

    check: async (subject) => {
      const block = await blockedBy(subject);
      if (block) {
        throw new InferenceBudgetExceededError(block.scopeKey, block.dimension, block.periodKey);
      }
    },

    record: async (subject, call) => {
      const at = now().toISOString();
      for (const scopeKey of scopeKeysFor(subject)) {
        const budget = await budgetFor(scopeKey);
        // Metered whether or not a budget exists, and whether or not it is
        // enabled: the first budget an operator writes on a crew that has been
        // running for weeks must not read as zero-used. The period is the
        // budget's own when there is one, else a calendar month.
        const period = budgetPeriod(
          budget ?? {
            crewId: scopeKey,
            period: "calendar_month",
            limits: {},
            policy: "soft",
            pauseHeartbeatOnBreach: true,
            enabled: false,
            updatedAt: at,
          },
          now(),
        );

        const before = budget
          ? budgetStatus(budget.limits, await store.usage(scopeKey, period.key)).state
          : "ok";
        const usage = await store.add({
          scopeKey,
          periodKey: period.key,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          usdMicros: call.usdMicros ?? 0,
          unpriced: call.usdMicros === null,
        });
        await store.appendEvent({
          scopeKey,
          periodKey: period.key,
          model: call.model,
          ...(call.provider ? { provider: call.provider } : {}),
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          usdMicros: call.usdMicros,
          priceSource: call.priceSource,
          tokensEstimated: call.tokensEstimated,
          ...(call.runId ? { runId: call.runId } : {}),
          ...(call.flowId ? { flowId: call.flowId } : {}),
          at,
        });

        if (!budget) continue;
        await announce(
          { scopeKey, budget, period, status: budgetStatus(budget.limits, usage) },
          before,
        );
      }
    },

    modelFor: async (subject, requested) => {
      let cheapest: string | undefined;
      for (const view of await coveringViews(subject)) {
        if (view.status.ratio < INFERENCE_BUDGET_WARN_RATIO) continue;
        // The narrower scope is visited last and wins: a seat that named its
        // own fallback knows more about its work than the crew default does.
        if (view.budget.cheapModel) cheapest = view.budget.cheapModel;
      }
      return cheapest ?? requested;
    },

    heartbeatBlock: async (crewId) => {
      const block = await blockedBy({ crewId });
      if (!block) return null;
      const budget = await store.get(block.scopeKey);
      // Only a budget that asked for it stops the timer. A hard budget that
      // did not still refuses each call — the heartbeat simply reports those
      // refusals, which is what an operator who turned this off asked for.
      return budget?.pauseHeartbeatOnBreach ? block : null;
    },

    events: async (subject, limit = 200) => {
      const keys = scopeKeysFor(subject);
      const scopeKey = keys[keys.length - 1]!;
      const budget = await store.get(scopeKey);
      const period = budget ? budgetPeriod(budget, now()) : null;
      return store.events(limit, scopeKey, period?.key);
    },

    usageBetween: async ({ scopeKeys, fromIso, toIso, limit = 20_000 }) =>
      store.eventsBetween({ scopeKeys, fromIso, toIso, limit }),

    hydrate: async () => (await store.list()).length,

    prune: async () => store.prune(),
  };
}

/** Whether this budget bounds anything at all — used by surfaces and health. */
export function budgetBounds(budget: InferenceBudget): number {
  return limitDimensions(budget.limits).length;
}

/** Zero counters, for surfaces that render a period nothing has landed in yet. */
export { ZERO_USAGE };
export type { InferenceUsage, InferenceBudgetStatus };
