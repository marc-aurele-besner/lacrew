import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProtocolEvent } from "@lacrew/core";
import {
  createAuditStoreFromEnv,
  createMemoryAuditStore,
  createPgAuditStore,
} from "./auditStore.js";

const EVENT: ProtocolEvent = {
  type: "ActionExecuted",
  at: new Date().toISOString(),
  payload: { agent: "0x1111111111111111111111111111111111111111", value: "75000000" },
};

describe("AuditStore", () => {
  it("memory store is a safe no-op", async () => {
    const store = createMemoryAuditStore();
    await store.append(EVENT);
    assert.deepEqual(await store.recent(10), []);
    await store.close();
  });

  it("falls back to memory without DATABASE_URL", async () => {
    const prev = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      assert.equal(createAuditStoreFromEnv().name, "memory");
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });

  it("memory store cannot answer the grouped usage reads", async () => {
    const store = createMemoryAuditStore();
    // Null, not []: the caller must fall back to its ring and say it is partial.
    assert.equal(await store.countByDayBetween(EVENT.at, EVENT.at), null);
    assert.equal(await store.countByAgentBetween(EVENT.at, EVENT.at), null);
  });

  it(
    "postgres store counts by UTC day and by agent over a half-open window",
    { skip: !process.env.DATABASE_URL },
    async () => {
      // A chain id of its own, so the shared table's other rows stay out of
      // this run's counts.
      const chainId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      const store = createPgAuditStore(undefined, chainId);
      const agent = "0xAbCdEfabcdefABCDEFabcdefabcdefABCDEFabcd";
      const at = (iso: string, type: ProtocolEvent["type"], payload = {}): ProtocolEvent => ({
        type,
        at: iso,
        payload,
      });
      try {
        await store.append(at("2026-03-01T00:00:00.000Z", "ActionExecuted", { agent }));
        await store.append(at("2026-03-01T23:59:59.999Z", "ActionExecuted", { agent }));
        await store.append(
          at("2026-03-02T00:00:00.000Z", "ActionExecuted", { agent: agent.toLowerCase() }),
        );
        await store.append(at("2026-03-02T09:00:00.000Z", "IntentCreated"));
        // On and before the edges: `to` itself is outside the window.
        await store.append(at("2026-02-28T23:59:59.999Z", "ActionExecuted", { agent }));
        await store.append(at("2026-03-04T00:00:00.000Z", "ActionExecuted", { agent }));

        const from = "2026-03-01T00:00:00.000Z";
        const to = "2026-03-04T00:00:00.000Z";
        assert.deepEqual(await store.countByDayBetween(from, to), [
          { day: "2026-03-01", type: "ActionExecuted", count: 2 },
          { day: "2026-03-02", type: "ActionExecuted", count: 1 },
          { day: "2026-03-02", type: "IntentCreated", count: 1 },
        ]);
        const byAgent = await store.countByAgentBetween(from, to);
        assert.ok(byAgent);
        assert.deepEqual(
          byAgent.find((row) => row.agent === agent.toLowerCase()),
          { agent: agent.toLowerCase(), type: "ActionExecuted", count: 3 },
        );
        assert.deepEqual(
          byAgent.find((row) => row.agent === null),
          { agent: null, type: "IntentCreated", count: 1 },
        );
        assert.equal(byAgent.length, 2);
      } finally {
        await store.close();
      }
    },
  );

  it("postgres store round-trips an event", { skip: !process.env.DATABASE_URL }, async () => {
    const store = createPgAuditStore();
    const marker = `test-${Date.now()}`;
    await store.append({ ...EVENT, payload: { ...EVENT.payload, marker } });
    const recent = await store.recent(50);
    try {
      assert.ok(
        recent.some((e) => e.payload.marker === marker),
        "appended event should be readable back",
      );
    } finally {
      await store.close();
    }
  });
});
