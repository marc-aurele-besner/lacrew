import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CORRELATION_TTL_MS,
  acknowledgement,
  authorityHint,
  correlationFooter,
  correlationIn,
  mintCorrelation,
  readInboundCommand,
  resolveInbound,
  threadLabel,
  verifyCorrelation,
  type BridgeTarget,
} from "./channelBridge.js";
import { MESSAGE_MAX_CHARS } from "./conversation.js";

const SECRET = "deployment-correlation-secret";
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const THREAD = "crew:trading";
const QUESTION = "msg_20260730_7";

const token = (over: { thread?: string; message?: string; now?: number } = {}) =>
  mintCorrelation(
    { thread: over.thread ?? THREAD, message: over.message ?? QUESTION },
    SECRET,
    over.now ?? NOW,
  );

const question = (over: Partial<BridgeTarget> = {}): BridgeTarget => ({
  id: QUESTION,
  threadId: THREAD,
  kind: "question",
  answered: false,
  ...over,
});

describe("correlation tokens", () => {
  it("round-trips a target", () => {
    const check = verifyCorrelation(token(), SECRET, NOW);
    assert.equal(check.ok, true);
    assert.deepEqual(check.ok ? { thread: check.thread, message: check.message } : null, {
      thread: THREAD,
      message: QUESTION,
    });
  });

  it("refuses a token this deployment did not sign", () => {
    // The whole point: without the signature, anyone who can guess a thread id
    // can write to it, because the inbound path has no session to check.
    assert.deepEqual(verifyCorrelation(token(), "another-deployments-secret", NOW), {
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a payload edited to name a different thread", () => {
    const forged = token();
    const [prefix, , signature] = forged.split(".");
    const swapped = Buffer.from(`crew:treasury|${QUESTION}|${Math.floor(NOW / 1000)}`).toString(
      "base64url",
    );
    assert.deepEqual(verifyCorrelation(`${prefix}.${swapped}.${signature}`, SECRET, NOW), {
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses malformed shapes without reading them", () => {
    for (const bad of ["", "nonsense", "lc1.only-two-parts", "lc2.aaa.bbb"]) {
      const check = verifyCorrelation(bad, SECRET, NOW);
      assert.equal(check.ok, false);
    }
  });

  it("expires, so an old chat log is not a set of live write handles", () => {
    const old = token({ now: NOW - CORRELATION_TTL_MS - 1000 });
    assert.deepEqual(verifyCorrelation(old, SECRET, NOW), { ok: false, reason: "expired" });
    // Still good a day inside the window.
    assert.equal(
      verifyCorrelation(token({ now: NOW - CORRELATION_TTL_MS + 86_400_000 }), SECRET, NOW).ok,
      true,
    );
  });

  it("is found wherever the platform put it", () => {
    const t = token();
    assert.equal(correlationIn(`> ${correlationFooter(t)}\n\nyes, ship it`), t);
    assert.equal(correlationIn("no ref here"), null);
  });
});

describe("readInboundCommand", () => {
  it("strips the mention and the ref from what gets stored", () => {
    const parsed = readInboundCommand(`<@U123> yes, ship it  ref ${token()}`, SECRET, NOW);
    assert.equal(parsed.body, "yes, ship it");
    assert.deepEqual(parsed.correlation, { thread: THREAD, message: QUESTION });
    assert.equal(parsed.command, "auto");
  });

  it("reads the explicit command grammar", () => {
    assert.equal(readInboundCommand("/note keep an eye on gas", SECRET, NOW).command, "note");
    assert.equal(readInboundCommand("answer: yes", SECRET, NOW).command, "answer");
    assert.equal(
      readInboundCommand("/note keep an eye on gas", SECRET, NOW).body,
      "keep an eye on gas",
    );
  });

  it("reports a bad token rather than silently ignoring it", () => {
    const parsed = readInboundCommand("yes ref lc1.YWJj.bad", SECRET, NOW);
    assert.equal(parsed.correlation, null);
    assert.equal(parsed.correlationError, "bad_signature");
  });
});

describe("resolveInbound", () => {
  const parse = (text: string) => readInboundCommand(text, SECRET, NOW);

  it("turns a reply to an open question into an answer on that thread", () => {
    const resolved = resolveInbound({
      parsed: parse(`yes, merge it ref ${token()}`),
      target: question(),
    });
    assert.deepEqual(resolved, {
      ok: true,
      kind: "answer",
      thread: THREAD,
      replyTo: QUESTION,
      body: "yes, merge it",
    });
  });

  it("keeps a reply to an already-answered question as a note", () => {
    // Closing a question twice would tell one of the two people their answer
    // decided something it did not.
    const resolved = resolveInbound({
      parsed: parse(`agreed ref ${token()}`),
      target: question({ answered: true }),
    });
    assert.equal(resolved.ok && resolved.kind, "note");
    assert.equal(resolved.ok && resolved.replyTo, QUESTION);
  });

  it("keeps a reply to a plan as a note that still points at the plan", () => {
    const resolved = resolveInbound({
      parsed: parse(`do the smaller one first ref ${token()}`),
      target: question({ kind: "plan" }),
    });
    assert.equal(resolved.ok && resolved.kind, "note");
    assert.equal(resolved.ok && resolved.replyTo, QUESTION);
  });

  it("refuses an uncorrelated message rather than guessing a thread", () => {
    assert.deepEqual(resolveInbound({ parsed: parse("what's happening?") }), {
      ok: false,
      reason: "no_correlation",
    });
  });

  it("lets an operator-bound chat post a note without a ref", () => {
    const resolved = resolveInbound({
      parsed: parse("heads up, the exchange is in maintenance"),
      boundThread: THREAD,
    });
    assert.deepEqual(resolved, {
      ok: true,
      kind: "note",
      thread: THREAD,
      body: "heads up, the exchange is in maintenance",
    });
  });

  it("refuses a forged ref before it refuses anything else", () => {
    // Ordering matters: a sender must not learn from the refusal that the
    // thread they guessed at exists, or that its question is closed.
    assert.deepEqual(
      resolveInbound({ parsed: parse("yes ref lc1.YWJj.bad"), boundThread: THREAD }),
      { ok: false, reason: "forged_correlation" },
    );
  });

  it("refuses an expired ref with its own reason", () => {
    const stale = readInboundCommand(
      `yes ref ${token({ now: NOW - CORRELATION_TTL_MS - 1 })}`,
      SECRET,
      NOW,
    );
    assert.deepEqual(resolveInbound({ parsed: stale }), {
      ok: false,
      reason: "expired_correlation",
    });
  });

  it("refuses a target the caller could not find in the named thread", () => {
    assert.deepEqual(resolveInbound({ parsed: parse(`yes ref ${token()}`), target: null }), {
      ok: false,
      reason: "unknown_target",
    });
  });

  it("refuses a target that came back from another thread", () => {
    assert.deepEqual(
      resolveInbound({
        parsed: parse(`yes ref ${token()}`),
        target: question({ threadId: "crew:treasury" }),
      }),
      { ok: false, reason: "thread_mismatch" },
    );
  });

  it("refuses a target whose id is not the one the token named", () => {
    assert.deepEqual(
      resolveInbound({
        parsed: parse(`yes ref ${token()}`),
        target: question({ id: "msg_other" }),
      }),
      { ok: false, reason: "unknown_target" },
    );
  });

  it("refuses an explicit /answer with nothing to answer", () => {
    assert.deepEqual(resolveInbound({ parsed: parse("/answer yes"), boundThread: THREAD }), {
      ok: false,
      reason: "no_correlation",
    });
    assert.deepEqual(
      resolveInbound({
        parsed: parse(`/answer yes ref ${token()}`),
        target: question({ kind: "note" }),
      }),
      { ok: false, reason: "not_a_question" },
    );
  });

  it("refuses an empty or oversized body", () => {
    assert.deepEqual(resolveInbound({ parsed: parse(`ref ${token()}`), target: question() }), {
      ok: false,
      reason: "empty_body",
    });
    const long = `${"x".repeat(MESSAGE_MAX_CHARS + 1)} ref ${token()}`;
    assert.deepEqual(resolveInbound({ parsed: parse(long), target: question() }), {
      ok: false,
      reason: "body_too_long",
    });
  });

  it("never produces a kind other than answer or note", () => {
    // Chat cannot make a plan, a result or a handoff: those are claims about
    // work, and the bridge only carries what a human typed at it.
    for (const kind of ["plan", "result", "handoff", "note", "question", "answer"] as const) {
      const resolved = resolveInbound({
        parsed: parse(`something ref ${token()}`),
        target: question({ kind }),
      });
      assert.ok(resolved.ok && (resolved.kind === "answer" || resolved.kind === "note"));
    }
  });
});

describe("sender-facing text", () => {
  it("acknowledges what landed without implying an outcome", () => {
    const ack = acknowledgement({ ok: true, kind: "answer", thread: THREAD, body: "yes" });
    assert.equal(ack, "Posted your answer on crew trading.");
    assert.match(
      acknowledgement({ ok: true, kind: "note", thread: "org", body: "hi" }),
      /note on the org thread/,
    );
  });

  it("labels threads a human can name", () => {
    assert.equal(threadLabel("crew:trading"), "crew trading");
    assert.equal(threadLabel("org"), "the org thread");
    assert.match(threadLabel("agent:0xabcdef0123456789"), /^agent 0xabcdef01/);
  });

  it("reminds a sender that chat is not authority", () => {
    assert.match(authorityHint("approve 500 USDC") ?? "", /can't approve/);
    assert.match(authorityHint("vote yes on the proposal") ?? "", /Governance/);
    assert.equal(authorityHint("yes, merge it"), null);
  });
});
