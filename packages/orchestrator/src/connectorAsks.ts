/**
 * Ask-mode connector writes: the human confirmation between "policy admits it"
 * and "it happened" (PRD F2.24).
 *
 * A write in `ask` mode does not call. It posts a `question` into the thread
 * the run's principal talks in, records what it was about to do, and suspends
 * the run. When a human answers `yes`, the run picks up at the same step and
 * the call goes out exactly once. When they answer `no`, the step is refused.
 * When nobody answers, it expires and the step is refused — the one direction a
 * timeout is allowed to fail in.
 *
 * ## The confirmation is a claim, not an approval
 *
 * The answer is an ordinary conversation message and carries no authority. It
 * releases a step that policy had *already* admitted; it cannot admit anything
 * policy refused, and a write that also needs a spend still raises its intent
 * and still meets the escalation path. Anything else would make a chat message
 * into a signature, which is the exact trust this protocol removes.
 *
 * ## Why a fingerprint, and not just a question id
 *
 * "Yes" answers a specific call — merge *this* pull request — and an agent that
 * could carry one yes to a different request would have been handed a blank
 * cheque by a human who thought they were signing one line. So an ask is keyed
 * by a hash of the request that will actually go out: method, path, and the
 * fields the route forwards. Different args are a different ask and a different
 * question. The same yes is spent once and never applies again.
 *
 * ## Why the run stops instead of waiting
 *
 * A person answers in minutes or hours. A run that blocked for that would tie a
 * funded crew's work to one process staying alive across a redeploy, and would
 * hold a session key open for the whole window. The run is suspended to
 * durable state instead, and whichever replica handles the answer resumes it.
 */

import { FlowWaitingError, type FlowResumeState } from "@lacrew/flows";
import type { ProtocolEvent } from "@lacrew/core";
import { createHash } from "node:crypto";
import { threadIdOf, type Message } from "./conversation.js";

/** How long a question waits before the step fails closed. */
export const DEFAULT_ASK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `LACREW_CONNECTOR_ASK_TTL_MS`, or a day.
 *
 * Bounded below because a deadline shorter than a lunch break is one that fires
 * on people rather than on neglect, and the failure it produces looks like a
 * bug in the flow.
 */
export function connectorAskTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.LACREW_CONNECTOR_ASK_TTL_MS ?? "");
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_ASK_TTL_MS;
}

export type ConnectorAskStatus =
  "pending" | "approved" | "declined" | "expired" | "cancelled" | "consumed";

/**
 * What the human said, once. `consumed` is separate from the outcome on
 * purpose: it records that the run has already acted on this answer, which is
 * what stops one yes from releasing the same write twice.
 */
export type ConnectorAskRecord = {
  id: string;
  connector: string;
  route: string;
  method: string;
  /** Rendered path with args filled in — what the operator is confirming. */
  path: string;
  /** Hash of the request that will go out; see the note on blank cheques. */
  fingerprint: string;
  /** Fields the route forwards, for the question body. Never a credential. */
  args: Record<string, unknown>;
  principal: string;
  threadId: string;
  /** Conversation message the human answers. */
  questionId: string;
  flowId?: string;
  runId?: string;
  status: ConnectorAskStatus;
  /** How it ended, kept after `consumed` overwrites `status`. */
  outcome?: "approved" | "declined" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  /** The suspended run, attached once `runFlow` returns it. */
  resume?: FlowResumeState;
};

/** An ask as it is safe to serve: everything above, since none of it is secret. */
export type ConnectorAskView = ConnectorAskRecord;

export interface ConnectorAskStore {
  loadConnectorAsks(): Promise<ConnectorAskRecord[]>;
  saveConnectorAsk(record: ConnectorAskRecord): Promise<void>;
}

export type ConnectorAskRequest = {
  connector: string;
  route: string;
  method: string;
  path: string;
  /** Only the fields the route actually forwards. */
  args: Record<string, unknown>;
  principal?: string;
  flowId?: string;
  runId?: string;
  /** Overrides the default `agent:<principal>` thread. */
  threadId?: string;
};

/**
 * Hash of the request a yes would release.
 *
 * Sorted keys so two callers building the same payload in a different order
 * produce the same ask rather than two questions for one merge.
 */
export function askFingerprint(input: {
  method: string;
  path: string;
  args: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(input.args)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
  return createHash("sha256")
    .update(`${input.method.toUpperCase()} ${input.path}\n${canonical}`)
    .digest("hex");
}

/** How much of one argument a question shows before it stops being readable. */
const ARG_PREVIEW_CHARS = 200;

/**
 * One argument as the question renders it.
 *
 * A push carries a whole file, and pasting it into a chat message buries the
 * two fields the human is actually deciding on — which branch, which path — in
 * kilobytes they will scroll past. The value is still pinned exactly: the
 * fingerprint is taken over the full args, so a yes releases the call that was
 * asked about and nothing else.
 */
function argPreview(value: unknown): string {
  const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  if (text.length <= ARG_PREVIEW_CHARS) return text;
  return `${text.slice(0, ARG_PREVIEW_CHARS)}… (${text.length} characters)`;
}

function askIdOf(request: ConnectorAskRequest, fingerprint: string): string {
  // Deterministic so two replicas racing the same suspended step converge on
  // one ask rather than posting the operator two questions about one merge.
  // The run id is in the key, so the *next* run asking the same thing gets its
  // own question — a yes belongs to the run that asked for it.
  const seed = [
    request.runId ?? "",
    (request.principal ?? "").toLowerCase(),
    `${request.connector}.${request.route}`,
    fingerprint,
  ].join("|");
  return `ask_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

/** The options a question offers. An answer must be one of these, exactly. */
export const ASK_OPTIONS = ["yes", "no"] as const;

/**
 * Read an answer as a decision, or as nothing.
 *
 * Only the offered options count. "sure, go ahead" is a sentence a person means
 * as a yes and a parser can only guess at, and a wrong guess here is a merge
 * nobody authorised — so free text resolves nothing and the question stays open.
 */
export function readAskAnswer(body: string): "approved" | "declined" | null {
  const normalized = body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  if (normalized === "yes") return "approved";
  if (normalized === "no") return "declined";
  return null;
}

export type ConnectorAsksSurface = {
  /**
   * Decide whether an ask-mode write may go out now. Returns when it may;
   * throws `FlowWaitingError` to suspend the run, or a refusal to end the step.
   */
  gate(request: ConnectorAskRequest): Promise<void>;
  list(): ConnectorAskView[];
  get(id: string): ConnectorAskRecord | undefined;
  /** Attach the suspended run to the ask that suspended it. */
  attachResume(id: string, resume: FlowResumeState): Promise<void>;
  /** Feed a conversation message in; resolves the ask it answers, if any. */
  observe(message: Message): void;
  /**
   * Close every question a run left open, because that run has ended.
   *
   * Deliberately without a resume: the run is over. A cancelled ask exists so a
   * late "yes" lands on a closed question instead of restarting a run — and so
   * a delegated run cancelled with its parent leaves nothing runnable.
   */
  cancelRun(runId: string, reason?: string): Promise<ConnectorAskRecord[]>;
  /** Expire asks past their deadline and let their runs fail closed. */
  sweep(now?: Date): Promise<ConnectorAskRecord[]>;
  /** Set by the flows surface; resuming needs to run a flow. */
  setResumer(resume: (ask: ConnectorAskRecord) => Promise<void>): void;
  /**
   * Settle every resume this surface has started. An answer arrives on a
   * message post, which cannot wait for a flow to finish, so the run is picked
   * up detached — this is how a shutdown (or a test) waits for it.
   */
  drain(): Promise<void>;
  hydrate(): Promise<number>;
};

export function createConnectorAsks(opts: {
  store?: ConnectorAskStore;
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
}): ConnectorAsksSurface {
  const now = opts.now ?? (() => new Date());
  const ttlMs = opts.ttlMs ?? DEFAULT_ASK_TTL_MS;
  const asks = new Map<string, ConnectorAskRecord>();
  const byQuestion = new Map<string, string>();
  let resumer: ((ask: ConnectorAskRecord) => Promise<void>) | undefined;
  const inFlight = new Set<Promise<void>>();

  /** Start a resume without waiting for it, but keep it drainable. */
  const startResume = (ask: ConnectorAskRecord): void => {
    if (!resumer) return;
    const started = resumer(ask)
      .catch(() => {})
      .finally(() => inFlight.delete(started));
    inFlight.add(started);
  };

  const index = (ask: ConnectorAskRecord): void => {
    asks.set(ask.id, ask);
    byQuestion.set(ask.questionId, ask.id);
  };

  const persist = async (ask: ConnectorAskRecord): Promise<void> => {
    index(ask);
    await opts.store?.saveConnectorAsk(ask).catch(() => {});
  };

  const audit = (
    type: "ConnectorAsk" | "ConnectorAskResolved" | "ConnectorAskUnresolved",
    ask: ConnectorAskRecord,
    extra: Record<string, unknown> = {},
  ): void => {
    opts.onEvent?.({
      type,
      at: now().toISOString(),
      payload: {
        askId: ask.id,
        connector: ask.connector,
        route: ask.route,
        method: ask.method,
        principal: ask.principal,
        threadId: ask.threadId,
        questionId: ask.questionId,
        ...(ask.flowId ? { flowId: ask.flowId } : {}),
        ...(ask.runId ? { runId: ask.runId } : {}),
        // The fingerprint, never the args: a path can carry a private repo name
        // and the trail is not the place to publish one.
        fingerprint: ask.fingerprint,
        ...extra,
      },
    });
  };

  const expireIfDue = (ask: ConnectorAskRecord, at: Date): boolean => {
    if (ask.status !== "pending" || ask.expiresAt > at.toISOString()) return false;
    ask.status = "expired";
    ask.outcome = "expired";
    ask.resolvedAt = at.toISOString();
    return true;
  };

  const questionBody = (request: ConnectorAskRequest): string => {
    const args = Object.entries(request.args)
      .map(([k, v]) => `  ${k}: ${argPreview(v)}`)
      .join("\n");
    return [
      `Confirm write: ${request.connector}.${request.route}`,
      `${request.method.toUpperCase()} ${request.path}`,
      ...(args ? ["", args] : []),
      "",
      // Said plainly because the question looks like an approval and is not one.
      "Answer yes to let this call go out once, or no to skip it. This confirms an external write only — it approves no spend and changes no policy.",
    ].join("\n");
  };

  return {
    setResumer: (fn) => {
      resumer = fn;
    },

    drain: async () => {
      // Loop: a resumed run can suspend on a *second* ask, whose answer may
      // already be in, which starts another resume while this one settles.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },

    list: () => [...asks.values()],
    get: (id) => asks.get(id),

    gate: async (request) => {
      const at = now();
      const fingerprint = askFingerprint({
        method: request.method,
        path: request.path,
        args: request.args,
      });
      const id = askIdOf(request, fingerprint);
      const existing = asks.get(id);

      if (existing) {
        if (expireIfDue(existing, at)) await persist(existing);
        if (existing.status === "approved") {
          existing.status = "consumed";
          await persist(existing);
          return;
        }
        if (existing.status === "declined") {
          existing.status = "consumed";
          await persist(existing);
          throw new Error(`connector_ask_declined:${request.connector}.${request.route}`);
        }
        if (existing.status === "expired") {
          existing.status = "consumed";
          await persist(existing);
          throw new Error(`connector_ask_timeout:${request.connector}.${request.route}`);
        }
        if (existing.status === "cancelled") {
          // The run this question belonged to was ended. Re-entering the step
          // is not a second chance at the write — the confirmation died with
          // the run, and a fresh run asks its own question.
          existing.status = "consumed";
          await persist(existing);
          throw new Error(`connector_ask_cancelled:${request.connector}.${request.route}`);
        }
        if (existing.status === "pending") {
          throw new FlowWaitingError({
            reason: "connector_ask",
            token: existing.id,
            detail: `waiting on a human to confirm ${request.connector}.${request.route}`,
          });
        }
        // Consumed: this run already spent its yes on this exact call. Asking
        // again would be a second write behind one confirmation.
        throw new Error(`connector_ask_spent:${request.connector}.${request.route}`);
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
        options: [...ASK_OPTIONS],
      });

      const ask: ConnectorAskRecord = {
        id,
        connector: request.connector,
        route: request.route,
        method: request.method.toUpperCase(),
        path: request.path,
        fingerprint,
        args: request.args,
        principal,
        threadId,
        questionId: question.id,
        ...(request.flowId ? { flowId: request.flowId } : {}),
        ...(request.runId ? { runId: request.runId } : {}),
        status: "pending",
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
      };
      await persist(ask);
      audit("ConnectorAsk", ask, { expiresAt: ask.expiresAt });

      throw new FlowWaitingError({
        reason: "connector_ask",
        token: ask.id,
        detail: `waiting on a human to confirm ${request.connector}.${request.route}`,
      });
    },

    attachResume: async (id, resume) => {
      const ask = asks.get(id);
      if (!ask) return;
      ask.resume = resume;
      await persist(ask);
      // The answer may already be in: a human who replies before the run has
      // finished suspending would otherwise leave it parked forever.
      if (ask.status === "approved" || ask.status === "declined") startResume(ask);
    },

    observe: (message) => {
      if (message.kind !== "answer" || !message.replyTo) return;
      const id = byQuestion.get(message.replyTo);
      if (!id) return;
      const ask = asks.get(id);
      if (!ask || ask.status !== "pending") return;

      const decision = readAskAnswer(message.body);
      if (!decision) {
        // The reply closed the question in the rail without deciding anything.
        // Re-asking is what keeps the queue honest — a waiting write that no
        // longer shows as waiting is one nobody comes back to.
        const reposted = opts.postQuestion({
          threadId: ask.threadId,
          author: ask.principal || "orchestrator",
          body: `Still waiting on ${ask.connector}.${ask.route}. Answer exactly "yes" or "no" — anything else is read as neither.`,
          options: [...ASK_OPTIONS],
        });
        byQuestion.delete(ask.questionId);
        ask.questionId = reposted.id;
        void persist(ask);
        audit("ConnectorAskUnresolved", ask, { answeredBy: message.author });
        return;
      }

      ask.status = decision;
      ask.outcome = decision;
      ask.resolvedAt = message.at;
      void persist(ask);
      audit("ConnectorAskResolved", ask, {
        outcome: decision,
        answeredBy: message.author,
        answerKind: message.authorKind,
      });
      // A run that has not attached its resume state yet is still suspending;
      // `attachResume` picks the resolution up when it lands.
      if (ask.resume) startResume(ask);
    },

    cancelRun: async (runId, reason) => {
      const closed: ConnectorAskRecord[] = [];
      for (const ask of asks.values()) {
        if (ask.runId !== runId || ask.status !== "pending") continue;
        ask.status = "cancelled";
        ask.outcome = "cancelled";
        ask.resolvedAt = now().toISOString();
        await persist(ask);
        audit("ConnectorAskResolved", ask, {
          outcome: "cancelled",
          ...(reason ? { reason } : {}),
        });
        closed.push(ask);
        // Not resumed, on purpose: the run is over, and the only thing this
        // record still does is refuse a late answer.
      }
      return closed;
    },

    sweep: async (at = now()) => {
      const expired: ConnectorAskRecord[] = [];
      for (const ask of asks.values()) {
        if (!expireIfDue(ask, at)) continue;
        await persist(ask);
        audit("ConnectorAskResolved", ask, { outcome: "expired" });
        expired.push(ask);
        if (ask.resume) startResume(ask);
      }
      return expired;
    },

    // Errors propagate: an ask that failed to load is a yes this process cannot
    // see, and a second call would mint a fresh question for it.
    hydrate: async () => {
      if (!opts.store) return 0;
      const loaded = await opts.store.loadConnectorAsks();
      for (const ask of loaded) index(ask);
      return loaded.length;
    },
  };
}
