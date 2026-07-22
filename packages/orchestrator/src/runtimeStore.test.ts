import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryRuntimeStore,
  createRuntimeStoreFromEnv,
  type IntentRecord,
  type SessionRecord,
} from "./runtimeStore.js";
import { CrewRuntime } from "./runtime.js";
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
