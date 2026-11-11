import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeSharedDb, sharedDb } from "./dbPool.js";
import type { ProtocolEvent } from "@lacrew/core";
import {
  createAuditStoreFromEnv,
  createMemoryAuditStore,
  createPgAuditStore,
} from "./auditStore.js";

// One pool for the file, as one process has; closed so the runner can exit.
after(async () => closeSharedDb());

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
      assert.equal(createAuditStoreFromEnv("default").name, "memory");
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
      const store = createPgAuditStore({ db: sharedDb(), orgId: "default", chainId });
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

  it(
    "postgres store keeps an identified event once and lets its fuller record replace it",
    { skip: !process.env.DATABASE_URL },
    async () => {
      const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const orgId = `audit-key-${run}`;
      const other = `audit-key-other-${run}`;
      const store = createPgAuditStore({ db: sharedDb(), orgId, ledger: "sandbox" });
      const neighbour = createPgAuditStore({ db: sharedDb(), orgId: other, ledger: "sandbox" });
      const key = `sim-${run}:simtx_00000007:AllowanceStreamed`;
      const copy = (node: string): ProtocolEvent => ({
        type: "AllowanceStreamed",
        at: new Date().toISOString(),
        ledger: "sandbox",
        payload: { simTxId: "simtx_00000007", node },
      });
      const typesOf = async (s: typeof store) =>
        (await s.recent(50)).map((e) => `${e.type}:${String(e.payload.node ?? e.payload.via)}`);
      try {
        // Two events of one transaction share the key and differ by index.
        await store.append(copy("a"), { identity: { key, index: 0 } });
        await store.append(copy("b"), { identity: { key, index: 1 } });
        // The same two again, as a second pass over the same trail would send them.
        await store.append(copy("a"), { identity: { key, index: 0 } });
        await store.append(copy("b"), { identity: { key, index: 1 } });
        assert.deepEqual((await typesOf(store)).sort(), [
          "AllowanceStreamed:a",
          "AllowanceStreamed:b",
        ]);
        // The same identity in another org is another event.
        await neighbour.append(copy("a"), { identity: { key, index: 0 } });
        // Events with no identity are never taken for one another.
        await store.append({ ...EVENT, ledger: "sandbox" });
        await store.append({ ...EVENT, ledger: "sandbox" });

        // The runtime's own record of the transaction stands for both copies.
        await store.append(
          { ...copy("-"), payload: { simTxId: "simtx_00000007", via: "EpochStreamer" } },
          { supersedes: key },
        );
        assert.deepEqual((await typesOf(store)).sort(), [
          "ActionExecuted:undefined",
          "ActionExecuted:undefined",
          "AllowanceStreamed:EpochStreamer",
        ]);
        assert.deepEqual(await typesOf(neighbour), ["AllowanceStreamed:a"]);
      } finally {
        await store.clearSandbox();
        await neighbour.clearSandbox();
      }
    },
  );

  it("postgres store round-trips an event", { skip: !process.env.DATABASE_URL }, async () => {
    const store = createPgAuditStore({ db: sharedDb(), orgId: "default" });
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
