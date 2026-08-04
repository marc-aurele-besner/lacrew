/**
 * The channel a crew talks on (PRD F1.7).
 *
 * A LaCrew organization already has two channels, and both are enforcement:
 * **intents** move money and are checked onchain, **proposals** change the
 * constitution and are voted onchain. Neither carries reasoning. An agent could
 * spend a budget but not say why; a human could approve or deny but not ask a
 * question first; two agents could delegate work but not hand over context.
 *
 * This is the third channel, and its defining property is that it is *not*
 * enforcement:
 *
 *   A message is a claim, never an authority. "I will spend 500 USDC" posted
 *   here permits nothing — the spend still meets the policy stack, still
 *   escalates, still needs its approval. Anything that reads a message as
 *   permission has reintroduced exactly the trust the protocol exists to
 *   remove, so nothing in this module returns a verdict, and callers must
 *   never route a decision through it.
 *
 * ## Claims are checkable, which is the point
 *
 * An agent reporting "merged the PR, cost 12 USDC" is worth nothing unless a
 * reader can check it. So a message carries `refs` — the intent, proposal,
 * transaction or flow run it is talking about — and a surface rendering it can
 * join those to the audit trail. A message with no refs is not a lie, but it is
 * unverified, and `verifiability()` says which so a UI can label it rather than
 * presenting every claim with equal confidence.
 *
 * ## Why kinds, and not just text
 *
 * The kinds exist because a human steering a crew needs to know what they are
 * looking at before they read it. A `plan` is a statement of intent that has
 * not happened yet and is the moment to redirect. A `question` is waiting on
 * someone and will keep waiting. A `result` already happened and can only be
 * audited. Flattening those into "message" puts the burden of that distinction
 * on the reader, every time, for every line.
 */

import { normalizeBlocks, refsOfBlocks, type MessageBlock } from "./messageBlocks.js";

/** Where a conversation happens. Crews are cloud-side labels, so ids are opaque. */
export type ThreadScope =
  { kind: "crew"; id: string } | { kind: "agent"; account: string } | { kind: "org" };

/**
 * What a message is doing.
 *
 * `plan` — what the author intends to do next. Not yet done; the moment to steer.
 * `question` — waiting on a reply, optionally with the options offered.
 * `answer` — a reply to a question, carrying `replyTo`.
 * `result` — something that already happened. Audit it, do not steer it.
 * `handoff` — work passed to another participant, with the context it needs.
 * `note` — everything else.
 */
export type MessageKind = "note" | "plan" | "question" | "answer" | "result" | "handoff";

export const MESSAGE_KINDS: MessageKind[] = [
  "note",
  "plan",
  "question",
  "answer",
  "result",
  "handoff",
];

/** Something a message claims to be about, so the claim can be checked. */
export type MessageRef = {
  kind: "intent" | "proposal" | "tx" | "flowRun";
  id: string;
};

export type Message = {
  id: string;
  threadId: string;
  at: string;
  /** Agent address, or an opaque human identifier the caller supplies. */
  author: string;
  authorKind: "agent" | "human";
  kind: MessageKind;
  body: string;
  /** Offered choices on a question. Advisory: an answer is free text. */
  options?: string[];
  /** The message this answers. Only meaningful on `answer`. */
  replyTo?: string;
  /** Who this is directed at — an agent address or crew id. */
  to?: string;
  refs?: MessageRef[];
  /**
   * Rich content: the data it found, the post it submitted, the fields it
   * extracted, a pointer to the intent or proposal it is talking about.
   * Validated in `messageBlocks.ts`, which treats every field as
   * attacker-controlled — see the note there on why a block carries a
   * reference and never an action.
   */
  blocks?: MessageBlock[];
  /**
   * How this message reached the thread, when it did not come from the app —
   * `telegram`, `slack`. Provenance, not authority: a message bridged in from
   * chat (F2.19) has already been attributed to a human seat by the time it
   * gets here, and this only lets a reader see that the sentence was typed
   * somewhere the app's rules do not reach. A surface that hid it would be
   * presenting a chat line and a signed-in post as the same thing.
   */
  via?: string;
};

export const MESSAGE_MAX_CHARS = 4_000;

export class MessageTooLongError extends Error {
  constructor(readonly chars: number) {
    super(`message_too_long (${chars} > ${MESSAGE_MAX_CHARS})`);
    this.name = "MessageTooLongError";
  }
}

export class UnknownMessageKindError extends Error {
  constructor(readonly kind: string) {
    super(`unknown_message_kind (${kind}); known: ${MESSAGE_KINDS.join(", ")}`);
    this.name = "UnknownMessageKindError";
  }
}

/**
 * Stable id for a thread.
 *
 * Deterministic so a caller can address a thread without first creating it —
 * posting to `crew:trading` works whether or not anyone has spoken there, which
 * is what lets an agent report into a channel it has never used.
 */
export function threadIdOf(scope: ThreadScope): string {
  if (scope.kind === "org") return "org";
  if (scope.kind === "crew") return `crew:${scope.id.trim().toLowerCase()}`;
  return `agent:${scope.account.trim().toLowerCase()}`;
}

/** Parse a thread id back to its scope; null when it is not one we issued. */
export function scopeOfThread(threadId: string): ThreadScope | null {
  if (threadId === "org") return { kind: "org" };
  const [prefix, ...rest] = threadId.split(":");
  const value = rest.join(":");
  if (!value) return null;
  if (prefix === "crew") return { kind: "crew", id: value };
  if (prefix === "agent") return { kind: "agent", account: value };
  return null;
}

export type PostInput = {
  scope: ThreadScope;
  author: string;
  authorKind: "agent" | "human";
  kind?: string;
  body: string;
  options?: string[];
  replyTo?: string;
  to?: string;
  refs?: MessageRef[];
  blocks?: readonly unknown[];
  via?: string;
};

/**
 * Provenance is a label, so it is constrained to look like one.
 *
 * Whatever posts a message controls this string, and it renders next to the
 * author's name — the one place in a thread a reader is trusting. A slug can
 * only ever be a slug; anything else is dropped rather than escaped, because
 * a surface should not have to be careful with it.
 */
function normalizeVia(raw: string | undefined): string | undefined {
  const slug = (raw ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,23}$/.test(slug) ? slug : undefined;
}

/**
 * Validate and normalize a post. Throws rather than silently correcting: a
 * message stored under a kind nobody asked for would misrepresent its author.
 */
export function normalizeMessage(input: PostInput, id: string, at: string): Message {
  const body = input.body.trim();
  if (!body) throw new Error("message_body_required");
  if (body.length > MESSAGE_MAX_CHARS) throw new MessageTooLongError(body.length);

  const kind = (input.kind ?? "note") as MessageKind;
  if (!MESSAGE_KINDS.includes(kind)) throw new UnknownMessageKindError(String(input.kind));

  const author = input.author.trim();
  if (!author) throw new Error("message_author_required");

  const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
  const refs = (input.refs ?? [])
    .filter((r) => r && typeof r.id === "string" && r.id.trim())
    .map((r) => ({ kind: r.kind, id: r.id.trim() }));

  const blocks = input.blocks ? normalizeBlocks(input.blocks) : [];
  const via = normalizeVia(input.via);

  return {
    id,
    threadId: threadIdOf(input.scope),
    at,
    author: input.authorKind === "agent" ? author.toLowerCase() : author,
    authorKind: input.authorKind,
    kind,
    body,
    ...(options.length > 0 ? { options } : {}),
    ...(input.replyTo?.trim() ? { replyTo: input.replyTo.trim() } : {}),
    ...(input.to?.trim() ? { to: input.to.trim() } : {}),
    ...(refs.length > 0 ? { refs } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
    ...(via ? { via } : {}),
  };
}

/**
 * Whether a message's claims can be checked, and against what.
 *
 * `unverified` is not an accusation. It is the honest label for a sentence
 * nothing corroborates, and a surface that rendered it identically to a claim
 * carrying a settled transaction would be doing the reader's judgement for
 * them — in the direction of trusting the agent more than the evidence allows.
 */
export function verifiability(message: Message): {
  status: "unverified" | "referenced";
  refs: MessageRef[];
} {
  // Ref blocks count as evidence too: attaching the intent as a block rather
  // than in `refs` is the same claim, and a reader would rightly expect it to
  // read the same way.
  const fromBlocks = refsOfBlocks(message.blocks ?? []).map((r) => ({
    kind: r.kind,
    id: r.id,
  }));
  const seen = new Set<string>();
  const refs = [...(message.refs ?? []), ...fromBlocks].filter((r) => {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { status: refs.length > 0 ? "referenced" : "unverified", refs };
}

/**
 * Questions in this thread that nobody has answered.
 *
 * A question is answered when a later message carries `replyTo` pointing at it.
 * Order matters: an "answer" posted before its question is not an answer to it,
 * and treating it as one would let a thread mark itself resolved out of order.
 */
export function openQuestions(messages: readonly Message[]): Message[] {
  const answeredAt = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.kind === "answer" && m.replyTo) {
      const existing = answeredAt.get(m.replyTo);
      if (existing === undefined || i < existing) answeredAt.set(m.replyTo, i);
    }
  });
  return messages.filter((m, i) => {
    if (m.kind !== "question") return false;
    const answer = answeredAt.get(m.id);
    return answer === undefined || answer < i;
  });
}

/**
 * The most recent plan nobody has acted on or answered.
 *
 * This is the steering window: a plan is the author saying what it is about to
 * do, and a human reading the thread wants the newest one rather than the whole
 * history. Returns null once a `result` from the same author follows it — at
 * that point the plan was carried out and steering it is no longer possible.
 */
export function pendingPlan(messages: readonly Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.kind !== "plan") continue;
    const actedOn = messages
      .slice(i + 1)
      .some((later) => later.kind === "result" && later.author === message.author);
    return actedOn ? null : message;
  }
  return null;
}

/** Bounded in-memory thread store; the durable copy rides RuntimeStore. */
export interface ConversationStore {
  loadMessages(): Promise<Message[]>;
  saveMessage(message: Message): Promise<void>;
}

export const THREAD_RING_MAX = 500;

/**
 * Conversation state for one orchestrator.
 *
 * Durable through `ConversationStore`, like standing controls: a crew whose
 * history vanished on restart would lose the answers to its own questions, and
 * an agent would re-ask what it had already been told.
 */
export class Conversation {
  private readonly messages: Message[] = [];
  private seq = 0;
  private store?: ConversationStore;
  hydrated = false;

  constructor(store?: ConversationStore) {
    this.store = store;
  }

  async hydrate(store = this.store): Promise<{ ok: boolean; loaded: number }> {
    if (!store) return { ok: false, loaded: 0 };
    this.store = store;
    try {
      const loaded = await store.loadMessages();
      this.messages.splice(0, this.messages.length, ...loaded);
      this.trim();
      this.hydrated = true;
      return { ok: true, loaded: loaded.length };
    } catch {
      return { ok: false, loaded: 0 };
    }
  }

  private trim(): void {
    if (this.messages.length > THREAD_RING_MAX) {
      this.messages.splice(0, this.messages.length - THREAD_RING_MAX);
    }
  }

  /** Ids are monotonic within a process; the store keeps them unique across restarts. */
  private nextId(at: string): string {
    this.seq += 1;
    return `msg_${at.replace(/[^0-9]/g, "").slice(0, 14)}_${this.seq}`;
  }

  post(input: PostInput, at = new Date().toISOString()): Message {
    const message = normalizeMessage(input, this.nextId(at), at);
    this.messages.push(message);
    this.trim();
    // Fire-and-forget: a store blip must not lose the message from this
    // process's view, nor turn a successful post into a failure.
    void this.store?.saveMessage(message).catch(() => {});
    return message;
  }

  /** Oldest → newest, so a reader follows the conversation forward. */
  thread(scope: ThreadScope, limit = 100): Message[] {
    const id = threadIdOf(scope);
    const all = this.messages.filter((m) => m.threadId === id);
    return all.slice(Math.max(0, all.length - limit));
  }

  /** Every message, newest first — the cross-thread feed a workspace renders. */
  recent(limit = 100): Message[] {
    return [...this.messages].reverse().slice(0, limit);
  }

  threads(): Array<{ threadId: string; messages: number; lastAt: string }> {
    const byThread = new Map<string, { messages: number; lastAt: string }>();
    for (const message of this.messages) {
      const entry = byThread.get(message.threadId);
      if (entry) {
        entry.messages += 1;
        if (message.at > entry.lastAt) entry.lastAt = message.at;
      } else {
        byThread.set(message.threadId, { messages: 1, lastAt: message.at });
      }
    }
    return [...byThread.entries()].map(([threadId, v]) => ({ threadId, ...v }));
  }

  openQuestionsIn(scope: ThreadScope): Message[] {
    return openQuestions(this.thread(scope, THREAD_RING_MAX));
  }

  /**
   * Every unanswered question, across every thread, oldest first.
   *
   * A question visible only inside the thread that holds it is a question the
   * human finds by opening each crew in turn — and one nobody opens is
   * indistinguishable from one nobody asked. Oldest first because the one that
   * has waited longest is the one holding something up.
   *
   * Scoped per thread rather than over the flat list: `openQuestions` closes a
   * question by a later `replyTo`, and answers only ever live in the thread
   * their question does. Run across threads the ordering would be meaningless
   * and an answer in one crew could close a question in another.
   */
  allOpenQuestions(): Message[] {
    const byThread = new Map<string, Message[]>();
    for (const message of this.messages) {
      const bucket = byThread.get(message.threadId);
      if (bucket) bucket.push(message);
      else byThread.set(message.threadId, [message]);
    }
    return [...byThread.values()]
      .flatMap((messages) => openQuestions(messages))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
}
