/**
 * Replying to a crew from chat (PRD F2.19).
 *
 * Outbound channels (F2.17) push alerts; pairing (F2.20) decides whose messages
 * count. This module is the third piece: turning an admitted chat message into
 * the *right* message, in the *right* thread.
 *
 * It lives in the public orchestrator because the rule it encodes is the same
 * rule the conversation surface already carries, and a copy of it inside a
 * hosted control plane would be a second answer to a question the protocol has
 * already answered — with no way for a self-hoster to check either one.
 *
 * ## The invariant this module exists to hold
 *
 * A message is a claim, never an authority. Chat is the loosest surface LaCrew
 * has: no session, no seat, a body anyone in a room can type. So the kinds it
 * can produce are deliberately two — `answer` and `note` — and neither means
 * anything to the enforcement layer. "approve 500 USDC" typed in Telegram
 * lands as text a human wrote in a thread; the intent it names is still sitting
 * in Approvals, unchanged, waiting for the seat that can actually approve it.
 * `authorityHint` exists so the bot can *say* that rather than let a sender
 * believe the words did something.
 *
 * ## Why a signed correlation and not a thread id
 *
 * A reply has to reach the message it answers. The obvious design — put the
 * thread id in the outbound alert and read it back — makes every crew thread in
 * every workspace writable by anyone who can guess `crew:trading`, because the
 * inbound path has no session to check the guess against. So the id travels as
 * a token this deployment signed, and a token that does not verify resolves to
 * nothing at all. A sender cannot mint a target; they can only return one they
 * were given.
 *
 * The signature is not a substitute for pairing. It proves *which thread*, not
 * *who* — F2.20's `authorizeInbound` still decides whether this person may
 * write there, and both must pass.
 */

import { MESSAGE_MAX_CHARS, type MessageKind } from "./conversation.js";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Marks a correlation token in text, so extraction is not a guess at shape. */
export const CORRELATION_PREFIX = "lc1";

/**
 * How long a token stays usable.
 *
 * Long enough that a question asked on Friday can be answered on Monday, short
 * enough that a chat log scraped a year later is not a set of live write
 * handles. A question outliving this is not lost — it is still in the Questions
 * rail, and the refusal says so.
 */
export const CORRELATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** What an outbound notification is pointing the reader at. */
export type CorrelationTarget = {
  /** Thread id as `threadIdOf` issues them — `crew:trading`, `org`, … */
  thread: string;
  /** The message a reply is about: the question asked, or the plan proposed. */
  message: string;
};

export type CorrelationCheck =
  | { ok: true; thread: string; message: string; issuedAt: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(payload: string, secret: string): string {
  // Truncated to 128 bits: the token rides in a chat footer a human sees, and
  // a full SHA-256 doubles its length for strength nothing here needs — the
  // payload is a thread id, not a bearer credential for funds.
  return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 22);
}

function constantEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * A token naming one message in one thread.
 *
 * `secret` is the deployment's, never a tenant's chat credential: rotating a
 * bot token must not invalidate every question already asked, and a secret a
 * platform has seen is not one that should be signing write targets.
 */
export function mintCorrelation(
  target: CorrelationTarget,
  secret: string,
  now = Date.now(),
): string {
  if (!secret) throw new Error("correlation_secret_required");
  const thread = target.thread.trim();
  const message = target.message.trim();
  if (!thread || !message) throw new Error("correlation_target_required");
  // Seconds, not millis: three fewer characters in something a human reads.
  const payload = b64url(`${thread}|${message}|${Math.floor(now / 1000)}`);
  return `${CORRELATION_PREFIX}.${payload}.${sign(payload, secret)}`;
}

/** The line an outbound notification carries so a reply can find its way home. */
export function correlationFooter(token: string): string {
  return `Reply to this message to answer · ref ${token}`;
}

/**
 * The token in a message, or null.
 *
 * Read from anywhere in the text because platforms quote differently: Telegram
 * puts the quoted message above the reply, Slack may inline it, and a person
 * may simply paste the ref. All three should work.
 */
export function correlationIn(text: string): string | null {
  const match = new RegExp(`${CORRELATION_PREFIX}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`).exec(text);
  return match ? match[0] : null;
}

export function verifyCorrelation(
  token: string,
  secret: string,
  now = Date.now(),
  ttlMs = CORRELATION_TTL_MS,
): CorrelationCheck {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CORRELATION_PREFIX) {
    return { ok: false, reason: "malformed" };
  }
  const [, payload, signature] = parts as [string, string, string];
  // Signature first: a forged payload must not be parsed, and an attacker must
  // not learn from the error whether their guess at a thread id was shaped
  // right. Everything below this line is content this deployment vouched for.
  if (!secret || !constantEquals(sign(payload, secret), signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const [thread, message, issued] = decoded.split("|");
  const issuedAt = Number(issued) * 1000;
  if (!thread || !message || !Number.isFinite(issuedAt)) {
    return { ok: false, reason: "malformed" };
  }
  if (now - issuedAt > ttlMs) return { ok: false, reason: "expired" };
  return { ok: true, thread, message, issuedAt };
}

/**
 * What the sender asked for, before we know whether it can be honoured.
 *
 * `auto` is the common case — someone hits reply and types. The explicit forms
 * exist for platforms whose reply threading is unreliable, and because "I meant
 * this as a side note, not as the answer" is a distinction only the sender can
 * make.
 */
export type BridgeCommand = "auto" | "answer" | "note";

export type InboundCommand = {
  command: BridgeCommand;
  /** The message body with the command, mention and ref stripped. */
  body: string;
  /** Present only when a token was found *and* verified. */
  correlation: { thread: string; message: string } | null;
  /** Set when a token was found and rejected; drives the refusal. */
  correlationError: "malformed" | "bad_signature" | "expired" | null;
};

/**
 * Strip what the platform added and the sender did not mean as content.
 *
 * A mention is how you reach a bot in a channel; a ref is how the reply finds
 * its thread. Storing either in the message body would put routing plumbing in
 * front of every human who later reads the thread.
 */
function stripEnvelope(text: string): string {
  return text
    .replace(new RegExp(`${CORRELATION_PREFIX}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`, "g"), " ")
    .replace(/\bref\s*[:·]?\s*$/gim, " ")
    .replace(/<@[^>]+>/g, " ")
    .replace(/(^|\s)@[A-Za-z0-9_]{3,32}bot\b/gi, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Read a chat message as an instruction, without deciding anything yet.
 *
 * Pure and synchronous: the caller has not yet fetched the thread, and the
 * cheap refusals (no ref, forged ref) should not cost a round trip to find out.
 */
export function readInboundCommand(text: string, secret: string, now = Date.now()): InboundCommand {
  const token = correlationIn(text);
  const check = token ? verifyCorrelation(token, secret, now) : null;
  const stripped = stripEnvelope(text);
  const explicit = /^\/?(answer|note)\b[:\s]*/i.exec(stripped);
  const command = (explicit?.[1]?.toLowerCase() ?? "auto") as BridgeCommand;
  return {
    command,
    body: explicit ? stripped.slice(explicit[0].length).trim() : stripped,
    correlation: check?.ok ? { thread: check.thread, message: check.message } : null,
    correlationError: check && !check.ok ? check.reason : null,
  };
}

/** The correlated message, as the caller read it back out of the thread. */
export type BridgeTarget = {
  id: string;
  threadId: string;
  kind: MessageKind;
  /** Whether something already answered it; a closed question cannot be reopened. */
  answered: boolean;
};

export type BridgeRefusal =
  | "no_correlation"
  | "forged_correlation"
  | "expired_correlation"
  | "unknown_target"
  | "thread_mismatch"
  | "not_a_question"
  | "empty_body"
  | "body_too_long";

export type BridgeResolution =
  | {
      ok: true;
      /** Only ever `answer` or `note`: chat cannot produce a plan or a result. */
      kind: Extract<MessageKind, "answer" | "note">;
      thread: string;
      replyTo?: string;
      body: string;
    }
  | { ok: false; reason: BridgeRefusal };

export type ResolveInboundInput = {
  parsed: InboundCommand;
  /**
   * The thread this chat was bound to by an operator, if any. A binding is what
   * makes an uncorrelated note land somewhere on purpose rather than somewhere
   * guessed — without one, a note has no home and is refused.
   */
  boundThread?: string | null;
  /** The correlated message, when the caller could find it. */
  target?: BridgeTarget | null;
};

/**
 * Where this message goes, and as what.
 *
 * Order matters, and it runs from "can this reach a thread at all" down to
 * "what should it be called". A refusal names the outermost reason, so a sender
 * is never told a question is closed by a token that was never valid.
 */
export function resolveInbound(input: ResolveInboundInput): BridgeResolution {
  const { parsed, boundThread, target } = input;

  if (parsed.correlationError === "bad_signature" || parsed.correlationError === "malformed") {
    return { ok: false, reason: "forged_correlation" };
  }
  if (parsed.correlationError === "expired") {
    return { ok: false, reason: "expired_correlation" };
  }

  const thread = parsed.correlation?.thread ?? boundThread?.trim() ?? "";
  if (!thread) return { ok: false, reason: "no_correlation" };

  if (parsed.correlation) {
    if (!target) return { ok: false, reason: "unknown_target" };
    // The caller fetched the thread the token named, so a message from another
    // thread here means the two disagree — which is the shape a stitched-
    // together token would have. Refuse rather than post to either.
    if (target.threadId !== parsed.correlation.thread) {
      return { ok: false, reason: "thread_mismatch" };
    }
    if (target.id !== parsed.correlation.message) return { ok: false, reason: "unknown_target" };
  }

  const body = parsed.body.trim();
  if (!body) return { ok: false, reason: "empty_body" };
  if (body.length > MESSAGE_MAX_CHARS) return { ok: false, reason: "body_too_long" };

  // An explicit `/answer` that has nothing to answer is a mistake worth
  // surfacing: silently downgrading it to a note would tell the sender their
  // answer landed while the question stayed open and the crew stayed blocked.
  if (parsed.command === "answer") {
    if (!target) return { ok: false, reason: "no_correlation" };
    if (target.kind !== "question") return { ok: false, reason: "not_a_question" };
    return { ok: true, kind: "answer", thread, replyTo: target.id, body };
  }

  if (parsed.command === "note") {
    return { ok: true, kind: "note", thread, ...(target ? { replyTo: target.id } : {}), body };
  }

  // `auto`: a reply to an open question is an answer, because that is what
  // hitting reply on "should I merge this?" means. Anything else keeps its
  // reference but stays a note — including a reply to a question someone else
  // already answered, which must not close it a second time.
  if (target && target.kind === "question" && !target.answered) {
    return { ok: true, kind: "answer", thread, replyTo: target.id, body };
  }
  return { ok: true, kind: "note", thread, ...(target ? { replyTo: target.id } : {}), body };
}

/** Human name for a thread, for text a sender reads. */
export function threadLabel(threadId: string): string {
  if (threadId === "org") return "the org thread";
  const [prefix, ...rest] = threadId.split(":");
  const value = rest.join(":");
  if (prefix === "crew" && value) return `crew ${value}`;
  if (prefix === "agent" && value) return `agent ${value.slice(0, 10)}…`;
  return threadId;
}

/**
 * What the bot says back when a message landed.
 *
 * Names the kind and the thread and stops there. "Posted" is the whole claim —
 * anything warmer ("done!", "approved") would let a sender read a thread post
 * as an outcome, which is the one misreading this surface cannot afford.
 */
export function acknowledgement(resolution: Extract<BridgeResolution, { ok: true }>): string {
  const where = threadLabel(resolution.thread);
  return resolution.kind === "answer"
    ? `Posted your answer on ${where}.`
    : `Posted a note on ${where}.`;
}

/**
 * Sender-facing text for a refusal.
 *
 * Never names a thread the sender did not already hold a token for, and never
 * distinguishes "that thread is not yours" from "that thread does not exist":
 * an endpoint anyone can message must not answer questions about a workspace's
 * shape.
 */
export function bridgeRefusalMessage(reason: BridgeRefusal): string {
  switch (reason) {
    case "no_correlation":
      return "Couldn't match this to an open question — reply to a LaCrew message, or open LaCrew.";
    case "forged_correlation":
    case "unknown_target":
    case "thread_mismatch":
      return "Couldn't match this to an open question — reply to a LaCrew message, or open LaCrew.";
    case "expired_correlation":
      return "That message is too old to reply to. Open LaCrew to answer it.";
    case "not_a_question":
      return "That message isn't a question. Send it as a note, or open LaCrew.";
    case "empty_body":
      return "Nothing to post — add some text.";
    case "body_too_long":
      return `Too long for a thread message (limit ${MESSAGE_MAX_CHARS} characters).`;
  }
}

/**
 * Whether this text reads like an instruction to move money or cast a vote.
 *
 * Not a filter — the message posts either way, as a claim. It exists so the bot
 * can say the quiet part out loud: a sender who typed "approve 500 USDC" and
 * got back "Posted your answer" has been given every reason to believe 500 USDC
 * moved. The reminder costs one line and closes that gap.
 */
export function authorityHint(text: string): string | null {
  const looksLikeAuthority =
    /\b(approve|approved|deny|denied|reject|veto|execute|vote|sign|transfer|send|pay|withdraw)\b/i.test(
      text,
    );
  if (!looksLikeAuthority) return null;
  return "Noted as a claim only — chat can't approve, vote or move funds. Use Approvals or Governance in LaCrew.";
}
