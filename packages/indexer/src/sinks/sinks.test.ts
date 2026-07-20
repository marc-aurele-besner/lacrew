import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryEventSink } from "./memory.js";
import { createEventSinksFromEnv, writeToSinks } from "./index.js";
import type { EventSink, IndexedEvent } from "./types.js";

const indexed = (overrides: Partial<IndexedEvent> = {}): IndexedEvent => ({
  event: { type: "ProposalVoted", at: "2026-07-20T00:00:00.000Z", payload: { proposalId: "1" } },
  txHash: "0xabc",
  logIndex: 0,
  ...overrides,
});

describe("EventSink", () => {
  it("records what it is written", async () => {
    const sink = new MemoryEventSink();
    await sink.write(indexed());
    assert.equal(sink.written.length, 1);
    assert.equal(sink.written[0]?.event.type, "ProposalVoted");
  });

  // Sinks are asked to swallow their own errors, but a third-party sink that
  // breaks that contract must not abort indexing or starve the sinks after it.
  it("keeps the fan-out going when a sink throws", async () => {
    const broken: EventSink = {
      name: "broken",
      write: async () => {
        throw new Error("sink down");
      },
      close: async () => {},
    };
    const good = new MemoryEventSink();

    await writeToSinks([broken, good], indexed());

    assert.equal(good.written.length, 1, "sink after the broken one was skipped");
  });

  it("configures no durable sink without DATABASE_URL", () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.deepEqual(createEventSinksFromEnv(), []);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });

  it("configures the postgres sink when DATABASE_URL is set", () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
    try {
      const sinks = createEventSinksFromEnv();
      assert.equal(sinks.length, 1);
      assert.equal(sinks[0]?.name, "postgres");
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});
