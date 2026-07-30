import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Conversation,
  MESSAGE_MAX_CHARS,
  MessageTooLongError,
  UnknownMessageKindError,
  normalizeMessage,
  openQuestions,
  pendingPlan,
  scopeOfThread,
  threadIdOf,
  verifiability,
  type Message,
} from "./conversation.js";

const AGENT = "0xAbCdEf0000000000000000000000000000000001";
const AT = "2026-07-28T12:00:00.000Z";

const msg = (over: Partial<Message>): Message => ({
  id: "m1",
  threadId: "crew:trading",
  at: AT,
  author: AGENT.toLowerCase(),
  authorKind: "agent",
  kind: "note",
  body: "hello",
  ...over,
});

describe("threadIdOf / scopeOfThread", () => {
  it("addresses a thread without anyone having spoken in it", () => {
    // Deterministic ids are what let an agent report into a channel it has
    // never used, rather than needing it created first.
    assert.equal(threadIdOf({ kind: "crew", id: "Trading" }), "crew:trading");
    assert.equal(threadIdOf({ kind: "agent", account: AGENT }), `agent:${AGENT.toLowerCase()}`);
    assert.equal(threadIdOf({ kind: "org" }), "org");
  });

  it("round-trips", () => {
    for (const scope of [
      { kind: "org" } as const,
      { kind: "crew", id: "trading" } as const,
      { kind: "agent", account: AGENT.toLowerCase() } as const,
    ]) {
      assert.deepEqual(scopeOfThread(threadIdOf(scope)), scope);
    }
  });

  it("refuses an id it did not issue", () => {
    assert.equal(scopeOfThread("nonsense"), null);
    assert.equal(scopeOfThread("crew:"), null);
  });
});

describe("normalizeMessage", () => {
  const base = { scope: { kind: "org" } as const, author: AGENT, authorKind: "agent" as const };

  it("defaults to a note and lowercases an agent author", () => {
    const m = normalizeMessage({ ...base, body: " hi " }, "m1", AT);
    assert.equal(m.kind, "note");
    assert.equal(m.body, "hi");
    assert.equal(m.author, AGENT.toLowerCase());
  });

  it("leaves a human author's identifier alone", () => {
    // Seat ids are opaque and case-sensitive; lowercasing one would stop it
    // resolving to the person it names.
    const m = normalizeMessage(
      { ...base, authorKind: "human", author: "Seat_AbC", body: "hi" },
      "m1",
      AT,
    );
    assert.equal(m.author, "Seat_AbC");
  });

  it("refuses an unknown kind rather than filing it as a note", () => {
    // Stored under a kind nobody asked for, the message would misrepresent its
    // author — a plan rendered as a result reads as something already done.
    assert.throws(
      () => normalizeMessage({ ...base, body: "x", kind: "shout" }, "m1", AT),
      UnknownMessageKindError,
    );
  });

  it("refuses an empty body and one past the ceiling", () => {
    assert.throws(() => normalizeMessage({ ...base, body: "   " }, "m1", AT), /body_required/);
    assert.throws(
      () => normalizeMessage({ ...base, body: "x".repeat(MESSAGE_MAX_CHARS + 1) }, "m1", AT),
      MessageTooLongError,
    );
  });

  it("drops blank options and refs rather than storing empty ones", () => {
    const m = normalizeMessage(
      {
        ...base,
        body: "pick",
        kind: "question",
        options: ["a", "  ", ""],
        refs: [{ kind: "intent", id: " 7 " }, { kind: "tx", id: "" }],
      },
      "m1",
      AT,
    );
    assert.deepEqual(m.options, ["a"]);
    assert.deepEqual(m.refs, [{ kind: "intent", id: "7" }]);
  });

  it("keeps provenance only when it looks like a channel slug", () => {
    // It renders next to the author's name, so whatever posts a message must
    // not be able to put markup — or a sentence — in that position.
    assert.equal(normalizeMessage({ ...base, body: "hi", via: "Telegram" }, "m1", AT).via, "telegram");
    for (const bad of ["<b>slack</b>", "posted by the ceo", "", "x".repeat(40)]) {
      assert.equal(normalizeMessage({ ...base, body: "hi", via: bad }, "m1", AT).via, undefined);
    }
  });
});

describe("verifiability", () => {
  it("labels a bare claim unverified", () => {
    assert.deepEqual(verifiability(msg({ kind: "result", body: "merged it" })), {
      status: "unverified",
      refs: [],
    });
  });

  it("labels a referenced claim so a reader can check it", () => {
    const m = msg({ kind: "result", refs: [{ kind: "intent", id: "12" }] });
    const v = verifiability(m);
    assert.equal(v.status, "referenced");
    assert.deepEqual(v.refs, [{ kind: "intent", id: "12" }]);
  });
});

describe("openQuestions", () => {
  it("finds a question nobody answered", () => {
    const q = msg({ id: "q1", kind: "question", body: "merge?" });
    assert.deepEqual(openQuestions([q]).map((m) => m.id), ["q1"]);
  });

  it("closes a question once answered", () => {
    const q = msg({ id: "q1", kind: "question", body: "merge?" });
    const a = msg({ id: "a1", kind: "answer", replyTo: "q1", body: "yes" });
    assert.deepEqual(openQuestions([q, a]), []);
  });

  it("does not let an answer posted before its question close it", () => {
    // Out of order, this would mark a thread resolved by a reply that cannot
    // have been to the question that follows it.
    const a = msg({ id: "a1", kind: "answer", replyTo: "q1", body: "yes" });
    const q = msg({ id: "q1", kind: "question", body: "merge?" });
    assert.deepEqual(openQuestions([a, q]).map((m) => m.id), ["q1"]);
  });

  it("ignores an answer pointing at nothing", () => {
    const q = msg({ id: "q1", kind: "question", body: "merge?" });
    const a = msg({ id: "a1", kind: "answer", replyTo: "gone", body: "yes" });
    assert.deepEqual(openQuestions([q, a]).map((m) => m.id), ["q1"]);
  });
});

describe("pendingPlan", () => {
  it("surfaces the newest plan — the steering window", () => {
    const p1 = msg({ id: "p1", kind: "plan", body: "first" });
    const p2 = msg({ id: "p2", kind: "plan", body: "second" });
    assert.equal(pendingPlan([p1, p2])?.id, "p2");
  });

  it("goes quiet once its author reports a result", () => {
    // The plan was carried out; presenting it as steerable would offer a
    // choice the operator no longer has.
    const p = msg({ id: "p1", kind: "plan", body: "will merge" });
    const r = msg({ id: "r1", kind: "result", body: "merged" });
    assert.equal(pendingPlan([p, r]), null);
  });

  it("stays open when a different author reported the result", () => {
    const p = msg({ id: "p1", kind: "plan", body: "will merge" });
    const r = msg({ id: "r1", kind: "result", author: "0xother", body: "did something else" });
    assert.equal(pendingPlan([p, r])?.id, "p1");
  });

  it("is null when nobody has planned anything", () => {
    assert.equal(pendingPlan([msg({ kind: "note" })]), null);
  });
});

describe("Conversation", () => {
  it("keeps threads apart and reads oldest first", () => {
    const c = new Conversation();
    c.post({ scope: { kind: "crew", id: "trading" }, author: AGENT, authorKind: "agent", body: "one" });
    c.post({ scope: { kind: "crew", id: "trading" }, author: AGENT, authorKind: "agent", body: "two" });
    c.post({ scope: { kind: "org" }, author: "seat1", authorKind: "human", body: "elsewhere" });

    const trading = c.thread({ kind: "crew", id: "trading" });
    assert.deepEqual(trading.map((m) => m.body), ["one", "two"]);
    assert.deepEqual(c.thread({ kind: "org" }).map((m) => m.body), ["elsewhere"]);
  });

  it("serves the cross-thread feed newest first", () => {
    const c = new Conversation();
    c.post({ scope: { kind: "org" }, author: "s", authorKind: "human", body: "older" });
    c.post({ scope: { kind: "org" }, author: "s", authorKind: "human", body: "newer" });
    assert.equal(c.recent()[0]?.body, "newer");
  });

  it("gives every message a distinct id inside one millisecond", () => {
    const c = new Conversation();
    const a = c.post({ scope: { kind: "org" }, author: "s", authorKind: "human", body: "a" }, AT);
    const b = c.post({ scope: { kind: "org" }, author: "s", authorKind: "human", body: "b" }, AT);
    assert.notEqual(a.id, b.id);
  });

  it("surfaces open questions per thread", () => {
    const c = new Conversation();
    const q = c.post({
      scope: { kind: "crew", id: "trading" },
      author: AGENT,
      authorKind: "agent",
      kind: "question",
      body: "merge?",
      options: ["yes", "no"],
    });
    assert.deepEqual(c.openQuestionsIn({ kind: "crew", id: "trading" }).map((m) => m.id), [q.id]);

    c.post({
      scope: { kind: "crew", id: "trading" },
      author: "seat1",
      authorKind: "human",
      kind: "answer",
      replyTo: q.id,
      body: "yes",
    });
    assert.deepEqual(c.openQuestionsIn({ kind: "crew", id: "trading" }), []);
  });

  it("restores history so a crew does not re-ask what it was told", async () => {
    const rows: Message[] = [];
    const store = {
      loadMessages: async () => [...rows],
      saveMessage: async (m: Message) => {
        rows.push(m);
      },
    };
    const first = new Conversation(store);
    const q = first.post({
      scope: { kind: "org" },
      author: AGENT,
      authorKind: "agent",
      kind: "question",
      body: "which repo?",
    });
    first.post({
      scope: { kind: "org" },
      author: "seat1",
      authorKind: "human",
      kind: "answer",
      replyTo: q.id,
      body: "the monorepo",
    });
    await Promise.resolve();

    const restarted = new Conversation(store);
    assert.deepEqual(await restarted.hydrate(), { ok: true, loaded: 2 });
    // The answer survived, so the agent does not ask again.
    assert.deepEqual(restarted.openQuestionsIn({ kind: "org" }), []);
    assert.equal(restarted.thread({ kind: "org" }).length, 2);
  });

  it("reports a failed load rather than presenting an empty history as real", async () => {
    const store = {
      loadMessages: async () => {
        throw new Error("store_down");
      },
      saveMessage: async () => {},
    };
    const c = new Conversation(store);
    assert.deepEqual(await c.hydrate(), { ok: false, loaded: 0 });
    assert.equal(c.hydrated, false);
  });

  it("gathers unanswered questions from every thread, oldest first", () => {
    const c = new Conversation();
    const older = c.post(
      { scope: { kind: "crew", id: "a" }, author: AGENT, authorKind: "agent", kind: "question", body: "first?" },
      "2026-07-28T10:00:00.000Z",
    );
    const newer = c.post(
      { scope: { kind: "crew", id: "b" }, author: AGENT, authorKind: "agent", kind: "question", body: "second?" },
      "2026-07-28T11:00:00.000Z",
    );
    // The one that has waited longest is the one holding something up.
    assert.deepEqual(c.allOpenQuestions().map((m) => m.id), [older.id, newer.id]);
  });

  it("does not let an answer in one crew close a question in another", () => {
    // Answers only ever live in their question's thread. Run across the flat
    // list, a stray replyTo would silently resolve someone else's question.
    const c = new Conversation();
    const q = c.post({
      scope: { kind: "crew", id: "a" },
      author: AGENT,
      authorKind: "agent",
      kind: "question",
      body: "merge?",
    });
    c.post({
      scope: { kind: "crew", id: "b" },
      author: "seat1",
      authorKind: "human",
      kind: "answer",
      replyTo: q.id,
      body: "yes",
    });
    assert.deepEqual(c.allOpenQuestions().map((m) => m.id), [q.id]);
  });

  it("is empty once every question is answered in its own thread", () => {
    const c = new Conversation();
    const q = c.post({
      scope: { kind: "crew", id: "a" },
      author: AGENT,
      authorKind: "agent",
      kind: "question",
      body: "merge?",
    });
    c.post({
      scope: { kind: "crew", id: "a" },
      author: "seat1",
      authorKind: "human",
      kind: "answer",
      replyTo: q.id,
      body: "yes",
    });
    assert.deepEqual(c.allOpenQuestions(), []);
  });

  it("lists threads with their activity", () => {
    const c = new Conversation();
    c.post({ scope: { kind: "crew", id: "a" }, author: "s", authorKind: "human", body: "x" });
    c.post({ scope: { kind: "crew", id: "b" }, author: "s", authorKind: "human", body: "y" });
    c.post({ scope: { kind: "crew", id: "b" }, author: "s", authorKind: "human", body: "z" });
    const threads = c.threads().sort((x, y) => x.threadId.localeCompare(y.threadId));
    assert.deepEqual(threads.map((t) => [t.threadId, t.messages]), [
      ["crew:a", 1],
      ["crew:b", 2],
    ]);
  });
});
