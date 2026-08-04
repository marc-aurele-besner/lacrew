/**
 * Dual control in the live process (PRD F2.32).
 *
 * `@lacrew/flows` owns what the control *is* — the modes, the thresholds, who
 * may review and what makes an answer count — so a CLI or a control plane can
 * say "this would have needed a second pair of eyes" without a runtime. This
 * module owns the parts that need one: the stored rules, the review question,
 * the parked run, the decision, and the trail all four leave behind.
 *
 * ## Where the check sits
 *
 * In front of the dispatch, never inside it. A run that stops here has built no
 * request, consulted no policy and sent nothing — the same ordering
 * plan-required uses, and for the same reason: "awaiting review" has to mean
 * the far side never heard from us, or an operator reading the trail cannot
 * tell a pause from a half-finished write.
 *
 * ## Why the run parks instead of waiting
 *
 * A reviewer answers in seconds when it is an agent and in hours when it is a
 * person. Blocking for that would pin a funded crew's work to one process
 * surviving a redeploy and hold a session key open for the whole window. The
 * run is suspended to durable state (F2.26) and whichever replica sees the
 * answer resumes it — exactly as an ask-mode write or a human gate does.
 *
 * ## Why a fingerprint
 *
 * A concurrence is about *this* effect: merge this pull request, propose this
 * amount to this target. An agent that could carry one concurrence to a
 * different call would have been handed a blank cheque by a reviewer who
 * thought they were agreeing to one line. So a review is keyed by a hash of the
 * call that will actually go out. Different arguments are a different review
 * and a different question, and one concurrence is spent exactly once.
 *
 * ## Failing closed
 *
 * Unlike plan-required, this control fails closed: a review that times out
 * refuses the effect, and a store this process cannot read refuses too. The
 * difference is what each thing bounds. Plan-required guards legibility, so an
 * outage there costs a missing sentence. Dual control is the second pair of
 * eyes an operator put in front of a merge or a spend, and an outage that
 * quietly removed it would deliver precisely the unreviewed effect the operator
 * was paying to prevent.
 */

import {
  DUAL_CONTROL_DEFAULT,
  DUAL_CONTROL_OPTIONS,
  FlowWaitingError,
  classifyDualEffect,
  concurrenceQualifies,
  dualControlRequired,
  dualControlScopeKey,
  formatReviewer,
  normalizeDualControlRule,
  parseReviewer,
  readReviewAnswer,
  resolveDualControl,
  resolveReviewer,
  type DualControlEffect,
  type DualControlMode,
  type DualControlRecord,
  type DualControlResolution,
  type DualControlRule,
  type DualControlScope,
  type DualControlSeat,
  type DualControlSubject,
  type FlowResumeState,
  type ReviewerTarget,
} from "@lacrew/flows";
import type { ProtocolEvent } from "@lacrew/core";
import { createHash } from "node:crypto";
import { threadIdOf, type Message } from "./conversation.js";

export type DualControlReviewStatus =
  "pending" | "concurred" | "rejected" | "timed_out" | "cancelled" | "consumed";

/**
 * One review: the effect it holds, who was asked, and what they said.
 *
 * `consumed` is separate from the outcome on purpose — it records that the run
 * has already acted on this decision, which is what stops one concurrence from
 * releasing the same effect twice.
 */
export type DualControlReviewRecord = {
  /** Deterministic per (run, actor, call): re-entering finds this review, never a second. */
  id: string;
  tool: string;
  effect: "spend" | "write";
  /** Hash of the call a concurrence would release; see the note on blank cheques. */
  fingerprint: string;
  /** The fields the question shows. Never a credential — see `summarizeArgs`. */
  args: Record<string, unknown>;
  /** Base units of a propose, as a decimal string, when this is a spend. */
  value?: string;
  /** The seat that wants to act. Never a qualifying reviewer of its own effect. */
  actor: string;
  /** The reviewer spec as configured, e.g. `manager` or `seat:0x…`. */
  reviewer: string;
  /** Seats asked to answer; empty when the question is addressed to people. */
  reviewers: string[];
  /** Whether people were asked — decides where the question lands. */
  human: boolean;
  /** The configured reviewer was unavailable and this is the fallback. */
  escalated: boolean;
  /** Whether a person may answer in place of an agent reviewer. Always true today. */
  humanOverride: boolean;
  threadId: string;
  /** Conversation message a reviewer answers. */
  questionId: string;
  flowId?: string;
  runId?: string;
  status: DualControlReviewStatus;
  /** How it ended, kept after `consumed` overwrites `status`. */
  outcome?: "concurred" | "rejected" | "timed_out" | "cancelled";
  /** The seat that decided, as the conversation attributed it. */
  decidedBy?: string;
  decidedByKind?: "agent" | "human";
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  /** The suspended run, attached once `runFlow` returns it. */
  resume?: FlowResumeState;
};

/** Nothing on a review is secret, so the served view is the record. */
export type DualControlReviewView = DualControlReviewRecord;

export interface DualControlStore {
  loadDualControlRules(): Promise<DualControlRecord[]>;
  saveDualControlRule(record: DualControlRecord): Promise<void>;
  removeDualControlRule(scopeKey: string): Promise<void>;
  loadDualControlReviews(): Promise<DualControlReviewRecord[]>;
  saveDualControlReview(record: DualControlReviewRecord): Promise<void>;
}

/**
 * Refusal for an effect the second seat turned down — or nobody answered.
 *
 * The marker property, not the prototype, is what `isDualControlRefused` tests:
 * `@lacrew/orchestrator` can be linked twice in one process (the cloud consumes
 * it from disk), and a refusal that failed `instanceof` would be reported as a
 * crash rather than as the control doing its job.
 */
export class DualControlRefusedError extends Error {
  readonly __dualControlRefused = true as const;
  readonly tool: string;
  readonly reviewId: string;
  readonly reason: "rejected" | "timed_out" | "cancelled";
  readonly decidedBy?: string;

  constructor(input: {
    tool: string;
    reviewId: string;
    reason: "rejected" | "timed_out" | "cancelled";
    decidedBy?: string;
  }) {
    super(
      `dual_control_${input.reason}:${input.tool} — ` +
        (input.reason === "rejected"
          ? `a second seat${input.decidedBy ? ` (${input.decidedBy})` : ""} rejected this effect; it was not attempted.`
          : input.reason === "timed_out"
            ? "nobody concurred before the review expired, so the effect fails closed and was not attempted."
            : "the run ended while this effect was awaiting review; it was not attempted."),
    );
    this.name = "DualControlRefusedError";
    this.tool = input.tool;
    this.reviewId = input.reviewId;
    this.reason = input.reason;
    if (input.decidedBy) this.decidedBy = input.decidedBy;
  }
}

export function isDualControlRefused(err: unknown): err is DualControlRefusedError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { __dualControlRefused?: unknown }).__dualControlRefused === true
  );
}

export type DualControlCheckInput = {
  /** Tool about to be called. Classified before anything is built. */
  tool: string;
  /** The arguments it would be called with — the threshold reads these. */
  args?: Record<string, unknown>;
  /** The seat that would act. Nested delegates pass their own principal (FR5). */
  principal: string;
  /** The principal's ancestors, nearest-first, for rule resolution. */
  managers?: readonly string[];
  flowId?: string;
  runId?: string;
  /** Classifies an operator-registered surface as a read or a write. */
  effectOf?: (tool: string) => "read" | "write" | undefined;
};

export type DualControlOutcome =
  | { required: false; mode: DualControlMode }
  | { required: true; mode: DualControlMode; reviewId: string; decidedBy?: string };

export type DualControlSurface = {
  /* rules */
  list(): DualControlRecord[];
  set(rule: DualControlRule): Promise<DualControlRecord>;
  /** Drop a rule, falling the scope back to what it inherits. */
  clear(scope: DualControlScope): Promise<boolean>;
  resolve(subject?: DualControlSubject): DualControlResolution;
  /** What one seat's reviewer setting resolves to against the live chart. */
  reviewerFor(principal: string, subject?: DualControlSubject): Promise<ReviewerTarget | null>;

  /* reviews */
  /**
   * Decide whether this call may go out now. Returns when it may; throws
   * `FlowWaitingError` to park the run on a review, or `DualControlRefusedError`
   * when the second seat said no or nobody answered.
   */
  check(input: DualControlCheckInput): Promise<DualControlOutcome>;
  reviews(): DualControlReviewView[];
  getReview(id: string): DualControlReviewRecord | undefined;
  /** Attach the suspended run to the review holding it. */
  attachResume(id: string, resume: FlowResumeState): Promise<void>;
  /** Feed a conversation message in; resolves the review it answers, if any. */
  observe(message: Message): void;
  /** Close the open reviews of a run that ended; they stop accepting answers. */
  cancelRun(runId: string, reason?: string): Promise<DualControlReviewRecord[]>;
  /** Time out reviews past their deadline and let their runs fail closed. */
  sweep(now?: Date): Promise<DualControlReviewRecord[]>;
  /** Set by the flows surface; resuming needs to run a flow. */
  setResumer(resume: (review: DualControlReviewRecord) => Promise<void>): void;
  /** Settle every resume this surface started (shutdown, and tests). */
  drain(): Promise<void>;
  hydrate(): Promise<{ rules: number; reviews: number }>;
};

/**
 * Workspace default from the environment.
 *
 * Self-host default is `off`: a control that turned itself on during an upgrade
 * would park every crew's first write on a question nobody knew to answer.
 * `LACREW_DUAL_CONTROL=risky_writes` opts in, with `LACREW_DUAL_CONTROL_REVIEWER`
 * and `LACREW_DUAL_CONTROL_MIN_SPEND` narrowing it.
 */
export function dualControlFromEnv(
  env: Record<string, string | undefined> = process.env,
): DualControlRule | null {
  const raw = (env.LACREW_DUAL_CONTROL ?? "").trim().toLowerCase();
  if (!raw || raw === "off") return null;
  if (raw !== "risky_writes" && raw !== "spends_and_writes") {
    throw new Error(
      `invalid LACREW_DUAL_CONTROL "${raw}": expected off | risky_writes | spends_and_writes`,
    );
  }
  const reviewerRaw = (env.LACREW_DUAL_CONTROL_REVIEWER ?? "").trim();
  // Parsed by the pure package so a bad value stops the boot rather than
  // silently becoming `manager` — a crew whose named reviewer agent is never
  // asked is a crew reviewing something other than what its config says.
  const reviewer = reviewerRaw ? parseReviewer(reviewerRaw) : undefined;
  if (reviewerRaw && !reviewer) {
    throw new Error(
      `invalid LACREW_DUAL_CONTROL_REVIEWER "${reviewerRaw}": expected ` +
        "manager | seat:<address> | role:human | any_peer_in_crew",
    );
  }
  const minutes = Number(env.LACREW_DUAL_CONTROL_TIMEOUT_MIN ?? "");
  const minSpend = (env.LACREW_DUAL_CONTROL_MIN_SPEND ?? "").trim();
  return {
    scope: { level: "workspace" },
    mode: raw,
    ...(reviewer ? { reviewer } : {}),
    ...(Number.isFinite(minutes) && minutes > 0 ? { timeoutMs: minutes * 60_000 } : {}),
    ...(minSpend ? { threshold: { minSpend } } : {}),
  };
}

/**
 * Hash of the call a concurrence would release.
 *
 * Sorted keys so two callers building the same payload in a different order
 * produce one review rather than two questions about one merge.
 */
export function reviewFingerprint(tool: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(args)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
  return createHash("sha256").update(`${tool}\n${canonical}`).digest("hex");
}

/**
 * What the reviewer is shown.
 *
 * Bounded and stringified rather than echoed: a tool's arguments can carry a
 * whole document, and a question a reviewer cannot read in one screen is a
 * question they concur with without reading.
 */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    out[key] = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }
  return out;
}

export function createDualControl(opts: {
  store?: DualControlStore;
  /** Posts the review question and returns the stored message. */
  postQuestion: (input: {
    threadId: string;
    author: string;
    body: string;
    options: string[];
    to?: string;
  }) => Message;
  /**
   * The org chart, for reviewer resolution. Read per call rather than cached:
   * a reparent that moved a seat under a new manager has to move its reviewer
   * with it, and a fired or paused reviewer has to stop being asked. An
   * unreadable chart yields an empty list, which resolves to "ask a person".
   */
  orgSeats: () => Promise<readonly DualControlSeat[]> | readonly DualControlSeat[];
  /** Rules the process starts with, e.g. from configuration. */
  seed?: readonly DualControlRule[];
  onEvent?: (event: ProtocolEvent) => void;
  now?: () => Date;
}): DualControlSurface {
  const now = opts.now ?? (() => new Date());
  const rules = new Map<string, DualControlRecord>();
  const reviews = new Map<string, DualControlReviewRecord>();
  const byQuestion = new Map<string, string>();
  let resumer: ((review: DualControlReviewRecord) => Promise<void>) | undefined;
  const inFlight = new Set<Promise<void>>();

  for (const rule of opts.seed ?? []) {
    const record = normalizeDualControlRule(rule, now().toISOString());
    rules.set(dualControlScopeKey(record.scope), record);
  }

  /** Start a resume without waiting for it, but keep it drainable. */
  const startResume = (review: DualControlReviewRecord): void => {
    if (!resumer) return;
    const started = resumer(review)
      .catch(() => {})
      .finally(() => inFlight.delete(started));
    inFlight.add(started);
  };

  const index = (review: DualControlReviewRecord): void => {
    reviews.set(review.id, review);
    byQuestion.set(review.questionId, review.id);
  };

  const persist = async (review: DualControlReviewRecord): Promise<void> => {
    index(review);
    await opts.store?.saveDualControlReview(review).catch(() => {});
  };

  const audit = (
    type:
      | "DualControlOpened"
      | "DualControlConcurred"
      | "DualControlRejected"
      | "DualControlTimedOut"
      | "DualControlUnresolved"
      | "DualControlChanged",
    review: DualControlReviewRecord,
    extra: Record<string, unknown> = {},
  ): void => {
    opts.onEvent?.({
      type,
      at: now().toISOString(),
      payload: {
        reviewId: review.id,
        tool: review.tool,
        effect: review.effect,
        actor: review.actor,
        reviewer: review.reviewer,
        reviewers: review.reviewers,
        escalated: review.escalated,
        threadId: review.threadId,
        questionId: review.questionId,
        ...(review.flowId ? { flowId: review.flowId } : {}),
        ...(review.runId ? { runId: review.runId } : {}),
        // The fingerprint and the amount, never the arguments: a call's fields
        // name repositories and counterparties, and the trail is not the place
        // to publish one. What a reader needs is which call this was and who
        // decided it.
        fingerprint: review.fingerprint,
        ...(review.value ? { value: review.value } : {}),
        ...extra,
      },
    });
  };

  const resolve = (subject: DualControlSubject = {}): DualControlResolution => {
    const list = [...rules.values()];
    if (list.length === 0) return { ...DUAL_CONTROL_DEFAULT, source: { kind: "default" } };
    // Precedence lives in the pure package; this file never re-implements it.
    return resolveDualControl(list, subject);
  };

  const expireIfDue = (review: DualControlReviewRecord, at: Date): boolean => {
    if (review.status !== "pending" || review.expiresAt > at.toISOString()) return false;
    review.status = "timed_out";
    review.outcome = "timed_out";
    review.resolvedAt = at.toISOString();
    return true;
  };

  const questionBody = (input: {
    tool: string;
    effect: DualControlEffect;
    actor: string;
    args: Record<string, unknown>;
    target: ReviewerTarget;
  }): string => {
    const fields = Object.entries(input.args)
      .map(([k, v]) => `  ${k}: ${String(v)}`)
      .join("\n");
    const what =
      input.effect.effect === "spend"
        ? `propose a spend of ${input.effect.value === null ? "an unreadable amount" : input.effect.value.toString()} base units`
        : `call ${input.tool}`;
    return [
      `Second pair of eyes: ${input.actor} is about to ${what}.`,
      `Tool: ${input.tool}`,
      ...(fields ? ["", fields] : []),
      "",
      `This run is paused until a different seat answers. Reply with exactly one of: ${DUAL_CONTROL_OPTIONS.join(", ")}.`,
      // Said plainly, because the question looks like an approval and is not
      // one — and because a reviewer who believes they are authorising a spend
      // will read the amount rather than the plan.
      "Concurring releases a paused step only: it approves no spend, changes no policy and signs nothing onchain." +
        " The policy stack, the escalation path and human approvals all still apply.",
      ...(input.target.escalated
        ? ["", "The configured reviewer was unavailable, so this came to you instead."]
        : []),
    ].join("\n");
  };

  /**
   * Where a review is asked.
   *
   * An agent reviewer is asked in its own thread, which is the thread it reads.
   * People are asked in the actor's thread, because that is the one the
   * Questions rail surfaces and the one carrying the context — the plan, the
   * prior steps — a person needs to decide.
   */
  const threadFor = (target: ReviewerTarget, actor: string): string =>
    !target.human && target.accounts.length === 1
      ? threadIdOf({ kind: "agent", account: target.accounts[0]! })
      : threadIdOf({ kind: "agent", account: actor });

  const reviewIdOf = (input: {
    runId?: string;
    actor: string;
    tool: string;
    fingerprint: string;
  }): string => {
    // Keyed by the run and the call, so a resume — or two replicas racing the
    // same parked run — converges on one question rather than asking twice. A
    // *different* run doing the same thing gets its own review: a concurrence
    // belongs to the run it was given for.
    const seed = [input.runId ?? "", input.actor.toLowerCase(), input.tool, input.fingerprint].join(
      "|",
    );
    return `review_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
  };

  return {
    list: () => [...rules.values()],

    set: async (rule) => {
      const record = normalizeDualControlRule(rule, now().toISOString());
      rules.set(dualControlScopeKey(record.scope), record);
      await opts.store?.saveDualControlRule(record);
      return record;
    },

    clear: async (scope) => {
      const key = dualControlScopeKey(scope);
      const existed = rules.delete(key);
      if (existed) await opts.store?.removeDualControlRule(key);
      return existed;
    },

    resolve,

    reviewerFor: async (principal, subject) => {
      const settings = resolve(subject ?? { principal });
      if (settings.mode === "off") return null;
      return resolveReviewer(settings.reviewer, principal, await opts.orgSeats());
    },

    setResumer: (fn) => {
      resumer = fn;
    },

    drain: async () => {
      // Loop: a resumed run can park on a *second* review whose answer is
      // already in, which starts another resume while this one settles.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },

    reviews: () => [...reviews.values()],
    getReview: (id) => reviews.get(id),

    check: async (input) => {
      const args = input.args ?? {};
      const effect = classifyDualEffect(input.tool, args, input.effectOf);
      const settings = resolve({ principal: input.principal, managers: input.managers ?? [] });
      if (!effect || !dualControlRequired(settings, effect)) {
        return { required: false, mode: settings.mode };
      }

      const at = now();
      const fingerprint = reviewFingerprint(input.tool, args);
      const id = reviewIdOf({
        ...(input.runId ? { runId: input.runId } : {}),
        actor: input.principal,
        tool: input.tool,
        fingerprint,
      });
      const existing = reviews.get(id);

      if (existing) {
        if (expireIfDue(existing, at)) {
          await persist(existing);
          audit("DualControlTimedOut", existing, { expiresAt: existing.expiresAt });
        }
        if (existing.status === "concurred") {
          existing.status = "consumed";
          await persist(existing);
          return {
            required: true,
            mode: settings.mode,
            reviewId: existing.id,
            ...(existing.decidedBy ? { decidedBy: existing.decidedBy } : {}),
          };
        }
        if (
          existing.status === "rejected" ||
          existing.status === "timed_out" ||
          existing.status === "cancelled"
        ) {
          const reason =
            existing.status === "rejected"
              ? "rejected"
              : existing.status === "timed_out"
                ? "timed_out"
                : "cancelled";
          existing.status = "consumed";
          await persist(existing);
          throw new DualControlRefusedError({
            tool: input.tool,
            reviewId: existing.id,
            reason,
            ...(existing.decidedBy ? { decidedBy: existing.decidedBy } : {}),
          });
        }
        if (existing.status === "pending") {
          throw new FlowWaitingError({
            reason: "dual_control",
            token: existing.id,
            detail: `awaiting review from ${describeReviewers(existing)}`,
          });
        }
        // Consumed: this run already acted on this decision. Re-entering would
        // run the released effect a second time behind one concurrence.
        throw new Error(`dual_control_spent:${input.tool}`);
      }

      const target = resolveReviewer(settings.reviewer, input.principal, await opts.orgSeats());
      const threadId = threadFor(target, input.principal);
      const shown = summarizeArgs(args);
      const question = opts.postQuestion({
        threadId,
        // Authored by the actor: the thread should read as the acting seat
        // asking for review, which is what happened.
        author: input.principal,
        body: questionBody({
          tool: input.tool,
          effect,
          actor: input.principal,
          args: shown,
          target,
        }),
        options: [...DUAL_CONTROL_OPTIONS],
        ...(target.accounts.length === 1 ? { to: target.accounts[0]! } : {}),
      });

      const review: DualControlReviewRecord = {
        id,
        tool: input.tool,
        effect: effect.effect,
        fingerprint,
        args: shown,
        ...(effect.effect === "spend" && effect.value !== null
          ? { value: effect.value.toString() }
          : {}),
        actor: input.principal,
        reviewer: formatReviewer(settings.reviewer),
        reviewers: target.accounts,
        human: target.human,
        escalated: target.escalated,
        humanOverride: target.humanOverride,
        threadId,
        questionId: question.id,
        ...(input.flowId ? { flowId: input.flowId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        status: "pending",
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + settings.timeoutMs).toISOString(),
      };
      await persist(review);
      audit("DualControlOpened", review, {
        mode: settings.mode,
        expiresAt: review.expiresAt,
      });

      throw new FlowWaitingError({
        reason: "dual_control",
        token: review.id,
        detail: `awaiting review from ${describeReviewers(review)}`,
      });
    },

    attachResume: async (id, resume) => {
      const review = reviews.get(id);
      if (!review) return;
      review.resume = resume;
      await persist(review);
      // The answer may already be in: a reviewer who replies before the run has
      // finished parking would otherwise leave it parked forever.
      if (review.status !== "pending") startResume(review);
    },

    observe: (message) => {
      if (message.kind !== "answer" || !message.replyTo) return;
      const id = byQuestion.get(message.replyTo);
      if (!id) return;
      const review = reviews.get(id);
      if (!review || review.status !== "pending") return;

      const target: ReviewerTarget = {
        via: "seat",
        accounts: review.reviewers,
        human: review.human,
        escalated: review.escalated,
        humanOverride: review.humanOverride,
      };
      if (
        !concurrenceQualifies(
          target,
          { author: message.author, authorKind: message.authorKind },
          review.actor,
        )
      ) {
        // The actor answering its own review is the attack this feature exists
        // to stop, so the attempt is recorded rather than swallowed — a trail
        // that showed nothing would make a self-concurring crew look idle.
        audit("DualControlUnresolved", review, {
          reason:
            message.author.trim().toLowerCase() === review.actor.trim().toLowerCase()
              ? "self_concurrence"
              : "not_a_reviewer",
          answeredBy: message.author,
          answerKind: message.authorKind,
        });
        return;
      }

      const decision = readReviewAnswer(message.body);
      if (!decision) {
        // The reply closed the question in the rail without deciding anything.
        // Re-asking is what keeps the queue honest — a paused run that no
        // longer shows as waiting is one nobody comes back to.
        const reposted = opts.postQuestion({
          threadId: review.threadId,
          author: review.actor,
          body:
            `This effect (${review.tool}) is still paused awaiting review. ` +
            `Reply with exactly one of: ${DUAL_CONTROL_OPTIONS.join(", ")} — anything else is read as neither.`,
          options: [...DUAL_CONTROL_OPTIONS],
        });
        byQuestion.delete(review.questionId);
        review.questionId = reposted.id;
        void persist(review);
        audit("DualControlUnresolved", review, {
          reason: "unrecognized",
          answeredBy: message.author,
        });
        return;
      }

      review.status = decision;
      review.outcome = decision;
      review.decidedBy = message.author;
      review.decidedByKind = message.authorKind;
      review.resolvedAt = message.at;
      void persist(review);
      audit(decision === "concurred" ? "DualControlConcurred" : "DualControlRejected", review, {
        decidedBy: message.author,
        decidedByKind: message.authorKind,
        ...(message.via ? { via: message.via } : {}),
      });
      // A run that has not attached its resume state yet is still parking;
      // `attachResume` picks the decision up when it lands.
      if (review.resume) startResume(review);
    },

    cancelRun: async (runId, reason) => {
      const closed: DualControlReviewRecord[] = [];
      for (const review of reviews.values()) {
        if (review.runId !== runId || review.status !== "pending") continue;
        review.status = "cancelled";
        review.outcome = "cancelled";
        review.resolvedAt = now().toISOString();
        await persist(review);
        audit("DualControlRejected", review, {
          outcome: "cancelled",
          ...(reason ? { reason } : {}),
        });
        closed.push(review);
        // Deliberately not resumed: the run is over. A cancelled review exists
        // so a late concurrence lands on a closed question instead of
        // restarting an effect the operator ended.
      }
      return closed;
    },

    sweep: async (at = now()) => {
      const timedOut: DualControlReviewRecord[] = [];
      for (const review of reviews.values()) {
        if (!expireIfDue(review, at)) continue;
        await persist(review);
        audit("DualControlTimedOut", review, { expiresAt: review.expiresAt });
        timedOut.push(review);
        // Resumed so the run reaches its refusal and ends, rather than sitting
        // in the stalled list forever with an expired question above it.
        if (review.resume) startResume(review);
      }
      return timedOut;
    },

    /**
     * Errors propagate. Unlike plan-required this control fails closed, and the
     * caller's job is to keep the surface out of the flows backend when its
     * rules could not be read — a review this process cannot see is a decision
     * somebody already made, and a second call would mint a fresh question.
     */
    hydrate: async () => {
      if (!opts.store) return { rules: 0, reviews: 0 };
      const loadedRules = await opts.store.loadDualControlRules();
      for (const record of loadedRules) rules.set(dualControlScopeKey(record.scope), record);
      const loadedReviews = await opts.store.loadDualControlReviews();
      for (const review of loadedReviews) index(review);
      return { rules: loadedRules.length, reviews: loadedReviews.length };
    },
  };
}

/** Who a parked run is waiting on, for the trace an operator reads. */
export function describeReviewers(review: {
  reviewers: string[];
  human: boolean;
  reviewer: string;
}): string {
  if (review.human) {
    return review.reviewers.length > 0 ? `a human (${review.reviewers.join(", ")})` : "a human";
  }
  if (review.reviewers.length === 0) return review.reviewer;
  return review.reviewers.join(" or ");
}
