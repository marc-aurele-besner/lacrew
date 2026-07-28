import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  messageFromRow,
  messageToRow,
  createMemoryRuntimeStore,
  createRuntimeStoreFromEnv,
  type IntentRecord,
  type SessionRecord,
} from "./runtimeStore.js";
import { CrewRuntime } from "./runtime.js";
import type { Message } from "./conversation.js";
import { createLacrewClient } from "@lacrew/sdk/testing";

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  keyId: "sess_1",
  agent: "0x2222222222222222222222222222222222222222",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  scopes: ["propose:intent"],
  mode: "mock",
  status: "active",
  issuedAt: new Date().toISOString(),
  ...overrides,
});

const intent = (overrides: Partial<IntentRecord> = {}): IntentRecord => ({
  intentId: "7",
  agent: "0x2222222222222222222222222222222222222222",
  target: "0x4444444444444444444444444444444444444444",
  value: "75000000",
  verdict: "ESCALATE",
  status: "pending",
  proposedAt: new Date().toISOString(),
  ...overrides,
});

describe("createMemoryRuntimeStore", () => {
  it("upserts sessions by keyId and lists newest first", async () => {
    const store = createMemoryRuntimeStore();
    await store.saveSession(session({ keyId: "a" }));
    await store.saveSession(session({ keyId: "b" }));
    await store.saveSession(session({ keyId: "a", status: "active", maxValue: "42" }));

    const sessions = await store.recentSessions(10);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.keyId, "b");
    assert.equal(sessions.find((s) => s.keyId === "a")?.maxValue, "42");
  });

  it("marks sessions revoked", async () => {
    const store = createMemoryRuntimeStore();
    await store.saveSession(session({ keyId: "a" }));
    await store.markSessionRevoked("a", new Date().toISOString());

    const [record] = await store.recentSessions(1);
    assert.equal(record?.status, "revoked");
    assert.ok(record?.revokedAt);
  });

  it("resolves only pending intent records for the id", async () => {
    const store = createMemoryRuntimeStore();
    await store.saveIntent(intent({ intentId: "0", verdict: "ALLOW", status: "executed" }));
    await store.saveIntent(intent({ intentId: "7" }));
    await store.markIntentResolved("7", {
      status: "approved",
      resolvedAt: new Date().toISOString(),
    });

    const intents = await store.recentIntents(10);
    assert.equal(intents.find((i) => i.intentId === "7")?.status, "approved");
    assert.equal(intents.find((i) => i.intentId === "0")?.status, "executed");
  });

  it("allows repeated ALLOW records sharing intentId 0", async () => {
    const store = createMemoryRuntimeStore();
    await store.saveIntent(intent({ intentId: "0", verdict: "ALLOW", status: "executed" }));
    await store.saveIntent(intent({ intentId: "0", verdict: "ALLOW", status: "executed" }));
    assert.equal((await store.recentIntents(10)).length, 2);
  });

  it("bounds retained records", async () => {
    const store = createMemoryRuntimeStore();
    for (let i = 0; i < 250; i++) {
      await store.saveIntent(intent({ intentId: String(i) }));
    }
    const intents = await store.recentIntents(300);
    assert.equal(intents.length, 200);
    assert.equal(intents[0]?.intentId, "249");
  });
});

describe("message row mapping", () => {
  /**
   * Every optional field populated. The point is the exhaustiveness: a field
   * added to `Message` and to the database schema, but forgotten in the mapping
   * between them, is invisible to every other test — the memory store holds the
   * object whole, so it round-trips there no matter what this mapping does.
   *
   * That is exactly how `blocks` shipped writing and reading as undefined
   * against Postgres while all 25 conversation tests passed.
   */
  const full: Message = {
    id: "msg_1",
    threadId: "crew:trading",
    at: "2026-07-28T12:00:00.000Z",
    author: "0xabc",
    authorKind: "agent",
    kind: "result",
    body: "done",
    options: ["yes", "no"],
    replyTo: "msg_0",
    to: "0xdef",
    refs: [{ kind: "intent", id: "12" }],
    blocks: [
      { kind: "fields", items: [{ label: "repo", value: "owner/repo" }] },
      { kind: "ref", ref: "intent", id: "12" },
    ],
  };

  it("round-trips every field a message can carry", () => {
    assert.deepEqual(messageFromRow(messageToRow(full)), full);
  });

  it("carries every key of the message into the row", () => {
    // Structural, so the next optional field cannot be dropped quietly: if it
    // is on the message and missing from the row, this fails without anyone
    // having to remember to extend the fixture's assertions.
    const row = messageToRow(full) as Record<string, unknown>;
    for (const key of Object.keys(full)) {
      // `to` is stored as `recipient`; everything else keeps its name.
      const column = key === "to" ? "recipient" : key;
      assert.ok(column in row, `message field "${key}" never reaches the row`);
    }
  });

  it("omits absent fields rather than storing empty ones", () => {
    const bare: Message = {
      id: "msg_2",
      threadId: "org",
      at: full.at,
      author: "seat1",
      authorKind: "human",
      kind: "note",
      body: "hi",
    };
    const row = messageToRow(bare) as Record<string, unknown>;
    for (const key of ["options", "replyTo", "recipient", "refs", "blocks"]) {
      assert.equal(key in row, false, `${key} was stored for a message without one`);
    }
    assert.deepEqual(messageFromRow(row as never), bare);
  });
});

describe("createRuntimeStoreFromEnv", () => {
  it("falls back to memory without DATABASE_URL", () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.equal(createRuntimeStoreFromEnv().name, "memory");
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });
});

describe("CrewRuntime runtime store wiring", () => {
  it("persists session + intent records across boot/tick/resolve", async () => {
    const store = createMemoryRuntimeStore();
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }), runtimeStore: store });

    const tick = await runtime.tick();
    assert.equal(tick.verdict, "ESCALATE");

    const sessions = await runtime.sessionHistory();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.status, "active");
    assert.equal(sessions[0]?.mode, "mock");

    let intents = await runtime.intentHistory();
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.status, "pending");
    assert.equal(intents[0]?.sessionKeyId, sessions[0]?.keyId);

    await runtime.resolve(tick.intentId, true);
    intents = await runtime.intentHistory();
    assert.equal(intents[0]?.status, "approved");
    assert.ok(intents[0]?.resolvedAt);
  });

  it("marks the session revoked in the store", async () => {
    const store = createMemoryRuntimeStore();
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }), runtimeStore: store });
    const booted = await runtime.boot();

    await runtime.revokeSessionById(booted.keyId);
    const [record] = await runtime.sessionHistory(1);
    assert.equal(record?.status, "revoked");
  });
});
