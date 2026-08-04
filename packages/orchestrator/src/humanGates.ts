/**
 * Blocking human gates: the step of a flow that stops until a person decides
 * (PRD F2.27).
 *
 * A `human` step posts one `question` into the thread its run talks in, parks
 * the run on durable state (F2.26), and goes no further. When someone answers
 * with one of the offered options, whichever replica reads that message resumes
 * the run down that option's port. When nobody answers, the gate times out and
 * the run takes the declared timeout port — or stops, which is the direction a
 * deadline is allowed to fail in.
 *
 * ## A gate is control, not authority
 *
 * The answer is an ordinary conversation message and permits nothing. It
 * releases a pipeline the running principal was already allowed to execute; it
 * cannot finalize an intent, widen a cap, or admit a call policy refused, and a
 * spend downstream of a gate still meets the policy stack and the escalation
 * path exactly as it would have without one. Anything that read this as an
 * approval would have turned a chat message into a signature.
 *
 * ## Why an agent cannot answer its own gate
 *
 * The point of the step is that a *person* decides. An agent posting "yes" into
 * the thread it also drives would be a crew approving its own publish, so only
 * a message the conversation attributed to a human seat resolves a gate — and
 * that attribution is made server-side when the message is posted, never by the
 * message claiming it.
 *
 * ## Why the run stops instead of waiting
 *
 * People answer in minutes or hours. A run that blocked for that would pin a
 * funded crew's work to one process surviving a redeploy and hold a session key
 * open for the whole window. The run is suspended to durable state instead.
 */

import { FlowWaitingError, type FlowResumeState, type HumanGateResolution } from "@lacrew/flows";
import type { ProtocolEvent } from "@lacrew/core";
import { createHash } from "node:crypto";
import { threadIdOf, type Message } from "./conversation.js";

/** How long a gate waits when the step does not say. */
export const DEFAULT_HUMAN_GATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Shortest deadline honoured, whatever a definition asks for. A gate that
 * expires faster than someone reads it fires on people rather than on neglect.
 */
export const MIN_HUMAN_GATE_TTL_MS = 5 * 60 * 1000;

/** `LACREW_HUMAN_GATE_TTL_MS`, or a day. */
export function humanGateTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.LACREW_HUMAN_GATE_TTL_MS ?? "");
  return Number.isFinite(raw) && raw >= MIN_HUMAN_GATE_TTL_MS ? raw : DEFAULT_HUMAN_GATE_TTL_MS;
}

/**
 * `consumed` is separate from the outcome on purpose: it records that the run
 * has already acted on this decision, which is what stops one answer from
 * releasing the same gate twice.
 */
export type HumanGateStatus = "pending" | "answered" | "timed_out" | "cancelled" | "consumed";

export type HumanGateOptionView = { id: string; label: string };

export type HumanGateRecord = {
  /** Deterministic per (run, step): re-entering finds this gate, never a second. */
  id: string;
  flowId?: string;
  runId?: string;
  stepId: string;
  /** The question a person reads, already interpolated. */
  prompt: string;
  options: HumanGateOptionView[];
  /** Human seat or role the question is addressed to. Advisory. */
  assignee?: string;
  principal: string;
  threadId: string;
  /** Conversation message the human answers. */
  questionId: string;
  status: HumanGateStatus;
  /** How it ended, kept after `consumed` overwrites `status`. */
  outcome?: "answered" | "timed_out" | "cancelled";
  /** The option picked, on `answered`. */
  optionId?: string;
  /** The human seat that picked it, as the conversation attributed it. */
  answeredBy?: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  /** The suspended run, attached once `runFlow` returns it. */
  resume?: FlowResumeState;
};

/** Nothing on a gate is secret, so the served view is the record. */
export type HumanGateView = HumanGateRecord;

export interface HumanGateStore {
  loadHumanGates(): Promise<HumanGateRecord[]>;
  saveHumanGate(record: HumanGateRecord): Promise<void>;
}

export type HumanGateRequest = {
  stepId: string;
  prompt: string;
  options: HumanGateOptionView[];
  assignee?: string;
  /** Step-declared deadline; clamped to `MIN_HUMAN_GATE_TTL_MS`. */
  timeoutMs?: number;
  principal?: string;
  flowId?: string;
  runId?: string;
  /** Overrides the default `agent:<principal>` thread. */
  threadId?: string;
};

function gateIdOf(request: HumanGateRequest): string {
  // Keyed by the run and the step, so a resume — or two replicas racing the
  // same parked run — converges on one question rather than asking twice. A
  // *different* run of the same flow gets its own gate: a decision belongs to
  // the run it was made about.
  const seed = [
    request.runId ?? "",
    request.flowId ?? "",
    request.stepId,
    (request.principal ?? "").toLowerCase(),
  ].join("|");
  return `gate_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

/**
 * Read an answer as one of the offered options, or as nothing.
 *
 * Only the listed ids count, trimmed and case-insensitive. "sure, go ahead" is
 * a sentence a person means as a yes and a parser can only guess at, and a
 * wrong guess here publishes something nobody chose — so free text decides
 * nothing and the gate stays open.
 */
export function readGateAnswer(body: string, options: HumanGateOptionView[]): string | null {
  const normalized = body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  const byId = options.find((o) => o.id.trim().toLowerCase() === normalized);
  if (byId) return byId.id;
  // A rail that renders buttons sends the label back on some channels; it is
  // still an exact match against something this gate offered, not a guess.
  const byLabel = options.find((o) => o.label.trim().toLowerCase() === normalized);
  return byLabel ? byLabel.id : null;
}

export type HumanGatesSurface = {
  /**
   * Decide whether a `human` step may continue now. Returns the resolution
   * when one has been made; throws `FlowWaitingError` to park the run.
   */
  gate(request: HumanGateRequest): Promise<HumanGateResolution>;
  list(): HumanGateView[];
  get(id: string): HumanGateRecord | undefined;
  /** Attach the suspended run to the gate holding it. */
  attachResume(id: string, resume: FlowResumeState): Promise<void>;
  /** Feed a conversation message in; resolves the gate it answers, if any. */
  observe(message: Message): void;
  /** Close the open gates of a run that ended; they stop accepting answers. */
  cancelRun(runId: string, reason?: string): Promise<HumanGateRecord[]>;
  /** Time out gates past their deadline and let their runs take that port. */
  sweep(now?: Date): Promise<HumanGateRecord[]>;
  /** Set by the flows surface; resuming needs to run a flow. */
  setResumer(resume: (gate: HumanGateRecord) => Promise<void>): void;
  /** Settle every resume this surface started (shutdown, and tests). */
  drain(): Promise<void>;
  hydrate(): Promise<number>;
};

export function createHumanGates(opts: {
  store?: HumanGateStore;
  /** Posts the question and returns the stored message. */
  postQuestion: (input: {
    threadId: string;
    author: string;
    body: string;
    options: string[];
  }) => Message;
  onEvent?: (event: ProtocolEvent) => void;
  ttlMs?: number;
  now?: () => Date;
}): HumanGatesSurface {
  const now = opts.now ?? (() => new Date());
  const defaultTtl = opts.ttlMs ?? DEFAULT_HUMAN_GATE_TTL_MS;
  const gates = new Map<string, HumanGateRecord>();
  const byQuestion = new Map<string, string>();
  let resumer: ((gate: HumanGateRecord) => Promise<void>) | undefined;
  const inFlight = new Set<Promise<void>>();

  /** Start a resume without waiting for it, but keep it drainable. */
  const startResume = (gate: HumanGateRecord): void => {
    if (!resumer) return;
    const started = resumer(gate)
      .catch(() => {})
      .finally(() => inFlight.delete(started));
    inFlight.add(started);
  };

  const index = (gate: HumanGateRecord): void => {
    gates.set(gate.id, gate);
    byQuestion.set(gate.questionId, gate.id);
  };

  const persist = async (gate: HumanGateRecord): Promise<void> => {
    index(gate);
    await opts.store?.saveHumanGate(gate).catch(() => {});
  };

  const audit = (
    type: "HumanGateOpened" | "HumanGateResolved" | "HumanGateTimedOut" | "HumanGateUnresolved",
    gate: HumanGateRecord,
    extra: Record<string, unknown> = {},
  ): void => {
    opts.onEvent?.({
      type,
      at: now().toISOString(),
      payload: {
        gateId: gate.id,
        stepId: gate.stepId,
        principal: gate.principal,
        threadId: gate.threadId,
        questionId: gate.questionId,
        ...(gate.flowId ? { flowId: gate.flowId } : {}),
        ...(gate.runId ? { runId: gate.runId } : {}),
        // The option ids, never the prompt: a rendered question can name a
        // private repo or a counterparty, and the trail is not where to publish
        // one. What a reader needs is which choice was offered and taken.
        options: gate.options.map((o) => o.id),
        ...extra,
      },
    });
  };

  const expireIfDue = (gate: HumanGateRecord, at: Date): boolean => {
    if (gate.status !== "pending" || gate.expiresAt > at.toISOString()) return false;
    gate.status = "timed_out";
    gate.outcome = "timed_out";
    gate.resolvedAt = at.toISOString();
    return true;
  };

  const questionBody = (request: HumanGateRequest): string => {
    const choices = request.options.map((o) => `  ${o.id} — ${o.label}`).join("\n");
    return [
      request.prompt.trim(),
      "",
      "This run is paused until you answer. Reply with exactly one of:",
      choices,
      "",
      // Said plainly because the question looks like an approval and is not one.
      "Answering releases a paused pipeline only — it approves no spend, changes no policy, and signs nothing onchain.",
    ].join("\n");
  };

  const resolutionOf = (gate: HumanGateRecord): HumanGateResolution => ({
    outcome: gate.outcome === "timed_out" ? "timed_out" : "answered",
    ...(gate.optionId ? { optionId: gate.optionId } : {}),
    ...(gate.answeredBy ? { answeredBy: gate.answeredBy } : {}),
    gateId: gate.id,
    ...(gate.resolvedAt ? { at: gate.resolvedAt } : {}),
  });

  return {
    setResumer: (fn) => {
      resumer = fn;
    },

    drain: async () => {
      // Loop: a resumed run can park on a *second* gate whose answer is already
      // in, which starts another resume while this one settles.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },

    list: () => [...gates.values()],
    get: (id) => gates.get(id),

    gate: async (request) => {
      const at = now();
      const id = gateIdOf(request);
      const existing = gates.get(id);

      if (existing) {
        if (expireIfDue(existing, at)) {
          await persist(existing);
          audit("HumanGateTimedOut", existing, {
            expiresAt: existing.expiresAt,
          });
        }
        if (existing.status === "answered" || existing.status === "timed_out") {
          const resolution = resolutionOf(existing);
          existing.status = "consumed";
          await persist(existing);
          return resolution;
        }
        if (existing.status === "cancelled") {
          throw new Error(`human_gate_cancelled:${request.stepId}`);
        }
        if (existing.status === "pending") {
          throw new FlowWaitingError({
            reason: "human_gate",
            token: existing.id,
            detail: `waiting on a human at "${request.stepId}"`,
          });
        }
        // Consumed: this run already acted on the decision. Re-entering would
        // run the released branch a second time behind one answer.
        throw new Error(`human_gate_spent:${request.stepId}`);
      }

      const principal = request.principal ?? "";
      const threadId =
        request.threadId ??
        (principal
          ? threadIdOf({ kind: "agent", account: principal })
          : threadIdOf({ kind: "org" }));
      const question = opts.postQuestion({
        threadId,
        author: principal || "orchestrator",
        body: questionBody(request),
        options: request.options.map((o) => o.id),
      });

      const ttl = Math.max(
        MIN_HUMAN_GATE_TTL_MS,
        request.timeoutMs && Number.isFinite(request.timeoutMs) ? request.timeoutMs : defaultTtl,
      );
      const gate: HumanGateRecord = {
        id,
        stepId: request.stepId,
        prompt: request.prompt,
        options: request.options,
        ...(request.assignee ? { assignee: request.assignee } : {}),
        principal,
        threadId,
        questionId: question.id,
        ...(request.flowId ? { flowId: request.flowId } : {}),
        ...(request.runId ? { runId: request.runId } : {}),
        status: "pending",
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + ttl).toISOString(),
      };
      await persist(gate);
      audit("HumanGateOpened", gate, {
        expiresAt: gate.expiresAt,
        ...(gate.assignee ? { assignee: gate.assignee } : {}),
      });

      throw new FlowWaitingError({
        reason: "human_gate",
        token: gate.id,
        detail: `waiting on a human at "${request.stepId}"`,
      });
    },

    attachResume: async (id, resume) => {
      const gate = gates.get(id);
      if (!gate) return;
      gate.resume = resume;
      await persist(gate);
      // The answer may already be in: someone who replies before the run has
      // finished parking would otherwise leave it parked forever.
      if (gate.status === "answered" || gate.status === "timed_out") startResume(gate);
    },

    observe: (message) => {
      if (message.kind !== "answer" || !message.replyTo) return;
      const id = byQuestion.get(message.replyTo);
      if (!id) return;
      const gate = gates.get(id);
      if (!gate || gate.status !== "pending") return;

      if (message.authorKind !== "human") {
        // A crew approving its own publish. The gate stays open, and the trail
        // records the attempt rather than swallowing it.
        audit("HumanGateUnresolved", gate, {
          reason: "not_human",
          answeredBy: message.author,
          answerKind: message.authorKind,
        });
        return;
      }

      const optionId = readGateAnswer(message.body, gate.options);
      if (!optionId) {
        // The reply closed the question in the rail without deciding anything.
        // Re-asking is what keeps the queue honest — a paused run that no
        // longer shows as waiting is one nobody comes back to.
        const reposted = opts.postQuestion({
          threadId: gate.threadId,
          author: gate.principal || "orchestrator",
          body:
            `This run is still paused at "${gate.stepId}". Reply with exactly one of: ` +
            `${gate.options.map((o) => o.id).join(", ")} — anything else is read as neither.`,
          options: gate.options.map((o) => o.id),
        });
        byQuestion.delete(gate.questionId);
        gate.questionId = reposted.id;
        void persist(gate);
        audit("HumanGateUnresolved", gate, {
          reason: "unrecognized",
          answeredBy: message.author,
        });
        return;
      }

      gate.status = "answered";
      gate.outcome = "answered";
      gate.optionId = optionId;
      gate.answeredBy = message.author;
      gate.resolvedAt = message.at;
      void persist(gate);
      audit("HumanGateResolved", gate, {
        outcome: "answered",
        optionId,
        answeredBy: message.author,
        ...(message.via ? { via: message.via } : {}),
      });
      // A run that has not attached its resume state yet is still parking;
      // `attachResume` picks the resolution up when it lands.
      if (gate.resume) startResume(gate);
    },

    cancelRun: async (runId, reason) => {
      const closed: HumanGateRecord[] = [];
      for (const gate of gates.values()) {
        if (gate.runId !== runId || gate.status !== "pending") continue;
        gate.status = "cancelled";
        gate.outcome = "cancelled";
        gate.resolvedAt = now().toISOString();
        await persist(gate);
        audit("HumanGateResolved", gate, {
          outcome: "cancelled",
          ...(reason ? { reason } : {}),
        });
        closed.push(gate);
        // Deliberately not resumed: the run is over. A cancelled gate exists so
        // a late answer lands on a closed question instead of restarting it.
      }
      return closed;
    },

    sweep: async (at = now()) => {
      const timedOut: HumanGateRecord[] = [];
      for (const gate of gates.values()) {
        if (!expireIfDue(gate, at)) continue;
        await persist(gate);
        audit("HumanGateTimedOut", gate, { expiresAt: gate.expiresAt });
        timedOut.push(gate);
        if (gate.resume) startResume(gate);
      }
      return timedOut;
    },

    // Errors propagate: a gate that failed to load is a decision this process
    // cannot see, and a second call would mint a fresh question for it.
    hydrate: async () => {
      if (!opts.store) return 0;
      const loaded = await opts.store.loadHumanGates();
      for (const gate of loaded) index(gate);
      return loaded.length;
    },
  };
}
