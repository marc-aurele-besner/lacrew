import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryQueue } from "./memory.js";

/**
 * Wait for a tick count to be reached, rather than sleeping a fixed span and
 * asserting how many fired.
 *
 * These are 20ms intervals, and the old form slept 55ms expecting >=2. On a
 * loaded machine — CI, or `turbo run test` fanning packages out in parallel —
 * the timer simply does not get 2 turns in 55ms, so the suite failed for
 * reasons that had nothing to do with the queue. Polling keeps the happy path
 * just as fast while giving a slow machine room.
 */
async function waitForCount(
  read: () => number,
  target: number,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (read() < target) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${target} ${label}, got ${read()}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("InMemoryQueue", () => {
  it("runs enqueued epoch handler after start", async () => {
    let epochs = 0;
    const q = new InMemoryQueue();
    await q.start({ onEpoch: async () => { epochs += 1; } });
    const id = await q.enqueue("epoch");
    assert.ok(id?.startsWith("mem_epoch_"));
    assert.equal(epochs, 1);
    assert.deepEqual(q.status(), {
      provider: "memory",
      ready: true,
      epochSchedule: null,
      flowCronSchedule: null,
    });
    await q.stop();
    assert.equal(q.status().ready, false);
  });

  it("schedules interval epochs when EPOCH_INTERVAL_MS is set", async () => {
    const prev = process.env.EPOCH_INTERVAL_MS;
    process.env.EPOCH_INTERVAL_MS = "20";
    let epochs = 0;
    const q = new InMemoryQueue();
    try {
      await q.start({ onEpoch: async () => { epochs += 1; } });
      await q.scheduleEpoch("0 * * * *");
      assert.equal(q.status().epochSchedule, "interval:20");
      await waitForCount(() => epochs, 2, "epoch ticks");
    } finally {
      await q.stop();
      if (prev === undefined) delete process.env.EPOCH_INTERVAL_MS;
      else process.env.EPOCH_INTERVAL_MS = prev;
    }
  });

  // Unlike epochs, the sweep runs without opt-in — detached demos still expect
  // cron flows to fire.
  it("sweeps cron flows on an interval by default", async () => {
    const prev = process.env.FLOW_CRON_POLL_MS;
    process.env.FLOW_CRON_POLL_MS = "20";
    let sweeps = 0;
    const q = new InMemoryQueue();
    try {
      await q.start({ onFlowCron: async () => { sweeps += 1; } });
      await q.scheduleFlowCron("* * * * *");
      assert.equal(q.status().flowCronSchedule, "interval:20");
      await waitForCount(() => sweeps, 2, "cron sweeps");
    } finally {
      await q.stop();
      if (prev === undefined) delete process.env.FLOW_CRON_POLL_MS;
      else process.env.FLOW_CRON_POLL_MS = prev;
    }
  });

  it("stops sweeping after stop()", async () => {
    const prev = process.env.FLOW_CRON_POLL_MS;
    process.env.FLOW_CRON_POLL_MS = "20";
    let sweeps = 0;
    const q = new InMemoryQueue();
    try {
      await q.start({ onFlowCron: async () => { sweeps += 1; } });
      await q.scheduleFlowCron("* * * * *");
      // Wait for sweeping to actually start, so "it stopped" is a real claim.
      // A fixed sleep here could observe zero sweeps on a slow machine and then
      // pass by asserting zero stayed zero, proving nothing.
      await waitForCount(() => sweeps, 1, "cron sweeps before stop");
      await q.stop();
      const after = sweeps;
      assert.equal(q.status().flowCronSchedule, null);
      await new Promise((r) => setTimeout(r, 55));
      assert.equal(sweeps, after, "sweeps continued after stop()");
    } finally {
      await q.stop();
      if (prev === undefined) delete process.env.FLOW_CRON_POLL_MS;
      else process.env.FLOW_CRON_POLL_MS = prev;
    }
  });
});
