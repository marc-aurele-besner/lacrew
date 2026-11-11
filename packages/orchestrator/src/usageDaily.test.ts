import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProtocolEvent } from "@lacrew/core";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { createMemoryAuditStore, type AuditStore } from "./auditStore.js";
import { CrewRuntime } from "./runtime.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB_CHECKSUMMED = "0xAbCdEfabcdefABCDEFabcdefabcdefABCDEFabcd";

/** What a row carries when no transaction was sent: these tests are about the counts. */
const NO_GAS = { gasFeeWei: "0", gasTxCount: 0 };

function event(type: ProtocolEvent["type"], at: string, agent?: string): ProtocolEvent {
  return { type, at, payload: agent ? { agent } : {} };
}

/** A runtime whose in-memory ring holds exactly `events` and has no database. */
async function ringRuntime(events: ProtocolEvent[]): Promise<CrewRuntime> {
  const auditStore: AuditStore = { ...createMemoryAuditStore(), recent: async () => events };
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }), auditStore });
  await runtime.hydrateAudit();
  return runtime;
}

/** A runtime whose store answers the grouped reads with fixed rows. */
function persistedRuntime(rows: {
  byDay?: Array<{ day: string; type: string; count: number }>;
  byAgent?: Array<{ agent: string | null; type: string; count: number }>;
}): CrewRuntime {
  const auditStore: AuditStore = {
    ...createMemoryAuditStore(),
    name: "postgres",
    countByDayBetween: async () => rows.byDay ?? [],
    countByAgentBetween: async () => rows.byAgent ?? [],
  };
  return new CrewRuntime({ client: createLacrewClient({ useMock: true }), auditStore });
}

describe("CrewRuntime.usageDaily", () => {
  it("buckets the ring by UTC day across a midnight, flagged incomplete", async () => {
    const runtime = await ringRuntime([
      event("ActionExecuted", "2026-03-01T23:59:59.999Z"),
      event("ActionExecuted", "2026-03-02T00:00:00.000Z"),
      event("IntentCreated", "2026-03-02T12:00:00.000Z"),
    ]);
    const usage = await runtime.usageDaily("2026-03-01T00:00:00.000Z", "2026-03-03T00:00:00.000Z");
    assert.deepEqual(usage.days, [
      { day: "2026-03-01", counts: { ActionExecuted: 1 }, ...NO_GAS },
      { day: "2026-03-02", counts: { ActionExecuted: 1, IntentCreated: 1 }, ...NO_GAS },
    ]);
    // The ring answered: a bounded count must never read as a period total.
    assert.equal(usage.complete, false);
    assert.equal(usage.store, "memory");
    assert.equal(usage.from, "2026-03-01T00:00:00.000Z");
    assert.equal(usage.to, "2026-03-03T00:00:00.000Z");
  });

  it("buckets by UTC day even when the timestamp carries another offset", async () => {
    // 23:30 at -05:00 is 04:30 the next day in UTC.
    const runtime = await ringRuntime([event("ActionExecuted", "2026-03-01T23:30:00.000-05:00")]);
    const usage = await runtime.usageDaily("2026-03-01T00:00:00.000Z", "2026-03-03T00:00:00.000Z");
    assert.deepEqual(usage.days, [
      { day: "2026-03-01", counts: {}, ...NO_GAS },
      { day: "2026-03-02", counts: { ActionExecuted: 1 }, ...NO_GAS },
    ]);
  });

  it("treats the window as half-open: from is counted, to is not", async () => {
    const runtime = await ringRuntime([
      event("ActionExecuted", "2026-02-28T23:59:59.999Z"),
      event("ActionExecuted", "2026-03-01T00:00:00.000Z"),
      event("ActionExecuted", "2026-03-02T00:00:00.000Z"),
    ]);
    const usage = await runtime.usageDaily("2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z");
    // A `to` on a midnight does not open a bucket for the day it starts.
    assert.deepEqual(usage.days, [{ day: "2026-03-01", counts: { ActionExecuted: 1 }, ...NO_GAS }]);
  });

  it("zero-fills every day the window touches, including partial edge days", async () => {
    const runtime = await ringRuntime([event("IntentCreated", "2026-03-03T08:00:00.000Z")]);
    const usage = await runtime.usageDaily("2026-03-01T18:00:00.000Z", "2026-03-05T06:00:00.000Z");
    assert.deepEqual(usage.days, [
      { day: "2026-03-01", counts: {}, ...NO_GAS },
      { day: "2026-03-02", counts: {}, ...NO_GAS },
      { day: "2026-03-03", counts: { IntentCreated: 1 }, ...NO_GAS },
      { day: "2026-03-04", counts: {}, ...NO_GAS },
      { day: "2026-03-05", counts: {}, ...NO_GAS },
    ]);
  });

  it("serves the persisted trail as complete, zero-filled around its rows", async () => {
    const runtime = persistedRuntime({
      byDay: [
        { day: "2026-03-02", type: "ActionExecuted", count: 7 },
        { day: "2026-03-02", type: "IntentCreated", count: 2 },
      ],
    });
    const usage = await runtime.usageDaily("2026-03-01T00:00:00.000Z", "2026-03-04T00:00:00.000Z");
    assert.deepEqual(usage.days, [
      { day: "2026-03-01", counts: {}, ...NO_GAS },
      { day: "2026-03-02", counts: { ActionExecuted: 7, IntentCreated: 2 }, ...NO_GAS },
      { day: "2026-03-03", counts: {}, ...NO_GAS },
    ]);
    assert.equal(usage.complete, true);
    assert.equal(usage.store, "postgres");
  });
});

describe("CrewRuntime.usageByAgent", () => {
  it("groups the ring by lower-cased agent, with agent-less events under null", async () => {
    const runtime = await ringRuntime([
      event("ActionExecuted", "2026-03-01T10:00:00.000Z", BOB_CHECKSUMMED),
      event("ActionExecuted", "2026-03-01T11:00:00.000Z", BOB_CHECKSUMMED.toLowerCase()),
      event("IntentCreated", "2026-03-01T12:00:00.000Z", ALICE),
      event("SessionIssued", "2026-03-01T13:00:00.000Z"),
      // Outside the window on both sides.
      event("ActionExecuted", "2026-02-28T23:59:59.999Z", ALICE),
      event("ActionExecuted", "2026-03-02T00:00:00.000Z", ALICE),
    ]);
    const usage = await runtime.usageByAgent(
      "2026-03-01T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
    );
    assert.deepEqual(usage.agents, [
      { agent: ALICE, counts: { IntentCreated: 1 }, ...NO_GAS },
      { agent: BOB_CHECKSUMMED.toLowerCase(), counts: { ActionExecuted: 2 }, ...NO_GAS },
      { agent: null, counts: { SessionIssued: 1 }, ...NO_GAS },
    ]);
    assert.equal(usage.complete, false);
    assert.equal(usage.store, "memory");
  });

  it("serves the persisted trail as complete, null agent last", async () => {
    const runtime = persistedRuntime({
      byAgent: [
        { agent: null, type: "SessionIssued", count: 3 },
        { agent: ALICE, type: "ActionExecuted", count: 4 },
        { agent: ALICE, type: "IntentCreated", count: 1 },
      ],
    });
    const usage = await runtime.usageByAgent(
      "2026-03-01T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
    );
    assert.deepEqual(usage.agents, [
      { agent: ALICE, counts: { ActionExecuted: 4, IntentCreated: 1 }, ...NO_GAS },
      { agent: null, counts: { SessionIssued: 3 }, ...NO_GAS },
    ]);
    assert.equal(usage.complete, true);
    assert.equal(usage.store, "postgres");
  });
});
