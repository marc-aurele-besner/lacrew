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

  it(
    "postgres store round-trips an event",
    { skip: !process.env.DATABASE_URL },
    async () => {
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
    },
  );
});
