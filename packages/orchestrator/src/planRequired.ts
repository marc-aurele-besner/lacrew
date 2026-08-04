/**
 * Plan-required mode in the live process (PRD F2.31).
 *
 * `@lacrew/flows` owns what the requirement *is* — the modes, which tools they
 * cover, and what makes a `plan` message qualify — so a CLI or a control plane
 * can answer "would this have been blocked?" without a runtime. This module
 * owns the parts that need one: the stored rules, the conversation read, the
 * refusal, and the audit row that refusal leaves behind.
 *
 * ## Where the check sits
 *
 * In front of the dispatch, never inside it. A flow's side-effecting step, an
 * `/mcp/call` from outside a flow — both ask here first, and a refusal means no
 * request was built, no policy was consulted, and nothing left the process. That
 * ordering is the whole claim of the feature: "blocked" has to mean the far
 * side never heard from us, or an operator reading the trail cannot tell a
 * refusal from a failure.
 *
 * ## Failing open, deliberately
 *
 * A store read that fails leaves crews acting exactly as they did before anyone
 * turned the mode on. This is the opposite of how inference budgets and the
 * external MCP allowlist fail, and the difference is what each thing bounds: a
 * budget guards money and an allowlist guards reach, so an unreadable one has to
 * refuse. Plan-required guards *legibility* — every onchain cap, whitelist,
 * connector mode and human gate still stands behind it — and stopping a funded
 * desk over a database blip would trade a real outage for a missing sentence.
 * The failure is logged loudly rather than silently, so nobody reads a quiet
 * trail as a crew that has been planning all along.
 */

import {
  PLAN_REQUIRED_DEFAULT,
  classifyPlanEffect,
  normalizePlanRequiredRule,
  planRequiredFor,
  planRequiredScopeKey,
  planThreadIds,
  qualifyingPlan,
  resolvePlanRequired,
  type PlanMessage,
  type PlanRequiredEffect,
  type PlanRequiredMiss,
  type PlanRequiredMode,
  type PlanRequiredRecord,
  type PlanRequiredResolution,
  type PlanRequiredRule,
  type PlanRequiredScope,
  type PlanRequiredSubject,
} from "@lacrew/flows";
import type { ProtocolEvent } from "@lacrew/core";
import type { Message } from "./conversation.js";

/**
 * How far back a thread is read when looking for a plan.
 *
 * Bounded rather than the whole ring: a plan older than the last few hundred
 * messages of its own thread is stale by any window this feature allows.
 */
const THREAD_LOOKBACK = 200;

/**
 * What a refused caller is told to do about it.
 *
 * Written as an instruction rather than a diagnosis: the agent that hit this is
 * usually the thing that has to fix it, and "post a plan first" is actionable
 * where a bare `plan_required` reads as a bug in the flow. It rides on the
 * error's own message so the sentence reaches the step trace an operator opens
 * and the model that has to try again, without either of them having to know
 * this module exists.
 */
export function planRequiredDetail(err: {
  tool: string;
  effect: PlanRequiredEffect;
  principal: string;
  mode: PlanRequiredMode;
  windowMs: number;
  miss: PlanRequiredMiss;
}): string {
  const minutes = Math.round(err.windowMs / 60_000);
  return (
    `${err.tool} is a ${err.effect === "spend" ? "spend" : "side effect"} and this crew runs in ` +
    `plan-required mode (${err.mode}). ` +
    (err.miss === "stale"
      ? `The most recent plan by ${err.principal} is older than ${minutes} minute(s).`
      : `${err.principal} has posted no plan in its thread.`) +
    " Post a `plan` message saying what you are about to do, then retry." +
    " A plan approves nothing — the policy stack still applies."
  );
}

/**
 * Refusal for a side effect nobody planned.
 *
 * The marker property, not the prototype, is what `isPlanRequired` tests —
 * `@lacrew/orchestrator` can be linked twice in one process (the cloud consumes
 * it from disk), and a refusal that failed `instanceof` would be reported as a
 * crash rather than as the control doing its job.
 */
export class PlanRequiredError extends Error {
  readonly __planRequired = true as const;
  readonly tool: string;
  readonly effect: PlanRequiredEffect;
  readonly principal: string;
  readonly mode: PlanRequiredMode;
  readonly windowMs: number;
  readonly miss: PlanRequiredMiss;

  constructor(input: {
    tool: string;
    effect: PlanRequiredEffect;
    principal: string;
    mode: PlanRequiredMode;
    windowMs: number;
    miss: PlanRequiredMiss;
  }) {
    super(`plan_required:${input.tool}:${input.miss} — ${planRequiredDetail(input)}`);
    this.name = "PlanRequiredError";
    this.tool = input.tool;
    this.effect = input.effect;
    this.principal = input.principal;
    this.mode = input.mode;
    this.windowMs = input.windowMs;
    this.miss = input.miss;
  }
}

export function isPlanRequired(err: unknown): err is PlanRequiredError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { __planRequired?: unknown }).__planRequired === true
  );
}

export type PlanRequiredCheckInput = {
  /** Tool about to be called. Classified before anything is built. */
  tool: string;
  principal: string;
  /** The principal's ancestors, nearest-first. */
  managers?: readonly string[];
  /** Run in flight, for the same-run exception. */
  runId?: string;
  /** When that run started — a plan current at the start stays current for it. */
  runStartedAt?: string;
  flowId?: string;
  stepId?: string;
  /** Seats that delegated this work; counted only when the rule accepts them. */
  upstream?: readonly string[];
  /**
   * Classifies an operator-registered surface as a read or a write. Absent, a
   * connector route or external MCP tool is treated as a write.
   */
  effectOf?: (tool: string) => "read" | "write" | undefined;
};

export type PlanRequiredOutcome =
  | { required: false; effect: PlanRequiredEffect | null; mode: PlanRequiredMode }
  | {
      required: true;
      effect: PlanRequiredEffect;
      mode: PlanRequiredMode;
      plan: { id: string; at: string };
    };

export interface PlanRequiredStore {
  loadPlanRequirements(): Promise<PlanRequiredRecord[]>;
  savePlanRequirement(record: PlanRequiredRecord): Promise<void>;
  removePlanRequirement(scopeKey: string): Promise<void>;
}

export type PlanRequirementsSurface = {
  list(): PlanRequiredRecord[];
  /** Set (or replace) the rule at one scope. Returns the stored record. */
  set(rule: PlanRequiredRule): Promise<PlanRequiredRecord>;
  /** Drop a rule, falling the scope back to what it inherits. */
  clear(scope: PlanRequiredScope): Promise<boolean>;
  resolve(subject?: PlanRequiredSubject): PlanRequiredResolution;
  /**
   * Decide whether this call may go out now. Returns when it may; throws
   * `PlanRequiredError` when the acting principal has not planned.
   */
  check(input: PlanRequiredCheckInput): Promise<PlanRequiredOutcome>;
  hydrate(): Promise<number>;
};

/**
 * Workspace default from the environment.
 *
 * Self-host default is `off` — a control that turned itself on during an
 * upgrade would stop a working desk with a message nobody had read the docs
 * for. `LACREW_PLAN_REQUIRED=side_effects` opts in.
 */
export function planRequiredFromEnv(
  env: Record<string, string | undefined> = process.env,
): PlanRequiredRule | null {
  const raw = (env.LACREW_PLAN_REQUIRED ?? "").trim().toLowerCase();
  if (!raw || raw === "off") return null;
  if (raw !== "spends_only" && raw !== "side_effects") {
    throw new Error(
      `invalid LACREW_PLAN_REQUIRED "${raw}": expected off | spends_only | side_effects`,
    );
  }
  const minutes = Number(env.LACREW_PLAN_REQUIRED_WINDOW_MIN ?? "");
  return {
    scope: { level: "workspace" },
    mode: raw,
    ...(Number.isFinite(minutes) && minutes > 0 ? { windowMs: minutes * 60_000 } : {}),
    ...(env.LACREW_PLAN_REQUIRED_UPSTREAM === "1" ? { acceptUpstreamPlan: true } : {}),
  };
}

export function createPlanRequirements(opts: {
  store?: PlanRequiredStore;
  /**
   * Reads one thread, oldest → newest. The conversation is the evidence this
   * whole feature rests on, so it is read live rather than cached: a plan
   * posted a second ago by the same run has to count.
   */
  messagesIn: (threadId: string) => readonly Message[];
  /** Rules the process starts with, e.g. from configuration. */
  seed?: readonly PlanRequiredRule[];
  onEvent?: (event: ProtocolEvent) => void;
  now?: () => Date;
}): PlanRequirementsSurface {
  const now = opts.now ?? (() => new Date());
  const rules = new Map<string, PlanRequiredRecord>();

  for (const rule of opts.seed ?? []) {
    const record = normalizePlanRequiredRule(rule, now().toISOString());
    rules.set(planRequiredScopeKey(record.scope), record);
  }

  const resolve = (subject: PlanRequiredSubject = {}): PlanRequiredResolution => {
    const list = [...rules.values()];
    if (list.length === 0) return { ...PLAN_REQUIRED_DEFAULT, source: { kind: "default" } };
    // Precedence lives in the pure package (narrowest-first, so an operator can
    // write one broad rule and carve seats out of it); this file never
    // re-implements it.
    return resolvePlanRequired(list, subject);
  };

  return {
    list: () => [...rules.values()],

    set: async (rule) => {
      const record = normalizePlanRequiredRule(rule, now().toISOString());
      rules.set(planRequiredScopeKey(record.scope), record);
      await opts.store?.savePlanRequirement(record);
      return record;
    },

    clear: async (scope) => {
      const key = planRequiredScopeKey(scope);
      const existed = rules.delete(key);
      if (existed) await opts.store?.removePlanRequirement(key);
      return existed;
    },

    resolve,

    check: async (input) => {
      const effect = classifyPlanEffect(input.tool, input.effectOf);
      const settings = resolve({ principal: input.principal, managers: input.managers ?? [] });
      if (!effect || !planRequiredFor(settings.mode, effect)) {
        return { required: false, effect, mode: settings.mode };
      }

      const threadIds = planThreadIds(input.principal, input.managers ?? []);
      const messages: PlanMessage[] = threadIds
        .flatMap((threadId) => opts.messagesIn(threadId).slice(-THREAD_LOOKBACK))
        // One ordering across threads: the newest statement of intent is the
        // current one wherever it was posted.
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

      const found = qualifyingPlan(messages, {
        principal: input.principal,
        threadIds,
        now: now(),
        windowMs: settings.windowMs,
        minPlanChars: settings.minPlanChars,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.runStartedAt && Number.isFinite(Date.parse(input.runStartedAt))
          ? { runStartedAt: new Date(input.runStartedAt) }
          : {}),
        ...(settings.acceptUpstreamPlan && input.upstream ? { upstream: input.upstream } : {}),
      });

      if (found.plan) {
        return {
          required: true,
          effect,
          mode: settings.mode,
          plan: { id: found.plan.id, at: found.plan.at },
        };
      }

      opts.onEvent?.({
        type: "PlanRequiredBlocked",
        at: now().toISOString(),
        payload: {
          tool: input.tool,
          effect,
          principal: input.principal,
          mode: settings.mode,
          scope:
            settings.source.kind === "rule"
              ? planRequiredScopeKey(settings.source.scope)
              : "default",
          windowMs: settings.windowMs,
          // Why it missed, never what the thread contains: a plan body names
          // repositories, counterparties and amounts, and the trail is not the
          // place to publish one.
          miss: found.miss,
          ...(input.flowId ? { flowId: input.flowId } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.stepId ? { stepId: input.stepId } : {}),
        },
      });
      throw new PlanRequiredError({
        tool: input.tool,
        effect,
        principal: input.principal,
        mode: settings.mode,
        windowMs: settings.windowMs,
        miss: found.miss,
      });
    },

    // Errors propagate: the caller decides what an unreadable rule set means,
    // and for this control the answer is to log it loudly and keep working —
    // see the note at the top of this file on why it fails open.
    hydrate: async () => {
      if (!opts.store) return 0;
      const loaded = await opts.store.loadPlanRequirements();
      for (const record of loaded) rules.set(planRequiredScopeKey(record.scope), record);
      return loaded.length;
    },
  };
}
