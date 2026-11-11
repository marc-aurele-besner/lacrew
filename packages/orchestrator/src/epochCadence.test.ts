import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidEpochCronError,
  createEpochCadence,
  processEpochStatus,
  type EpochScheduleRow,
  type EpochScheduleStore,
} from "./epochCadence.js";

const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const HOUR = 3600;
const DAY = 86_400;

/** One org's stored cadence, with the conditional write a directory row gives. */
function memoryStore(initial: Partial<EpochScheduleRow> = {}) {
  let row: EpochScheduleRow | null = { cron: null, nextAt: null, dueAt: null, ...initial };
  const writes: Array<{ nextAt: string | null; dueAt: string | null }> = [];
  const store: EpochScheduleStore = {
    read: async () => (row ? { ...row } : null),
    write: async (change, ifNextAt) => {
      if (!row) return false;
      if (ifNextAt !== undefined && row.nextAt !== ifNextAt) return false;
      row = {
        cron: change.cron === undefined ? row.cron : change.cron,
        nextAt: change.nextAt,
        dueAt: change.dueAt,
      };
      writes.push({ nextAt: change.nextAt, dueAt: change.dueAt });
      return true;
    },
  };
  return {
    store,
    writes,
    row: () => row,
    remove: () => {
      row = null;
    },
  };
}

/** A cadence on a wall clock that stands still and an org clock that can be skipped. */
function cadenceAt(
  wallIso: string,
  options: { defaultCron?: string; store?: ReturnType<typeof memoryStore> } = {},
) {
  const clock = { wall: at(wallIso), offset: 0 };
  const kept = options.store ?? memoryStore();
  let runs = 0;
  const cadence = createEpochCadence({
    store: kept.store,
    defaultCron: options.defaultCron ?? "0 * * * *",
    now: () => clock.wall + clock.offset,
    offset: () => clock.offset,
    run: async () => {
      runs += 1;
    },
  });
  return { cadence, clock, kept, runs: () => runs };
}

describe("epoch cadence: when the next epoch is", () => {
  it("works the next epoch out from the default cron the first time it is asked", async () => {
    const { cadence, kept } = cadenceAt("2026-11-11T10:20:00Z");
    assert.deepEqual(await cadence.status(), {
      schedule: "0 * * * *",
      source: "default",
      clock: "org",
      nextAt: at("2026-11-11T11:00:00Z"),
      nextAtIso: "2026-11-11T11:00:00.000Z",
      secondsUntilNext: 40 * 60,
    });
    assert.deepEqual(kept.row(), {
      cron: null,
      nextAt: "2026-11-11T11:00:00.000Z",
      dueAt: "2026-11-11T11:00:00.000Z",
    });
  });

  it("keeps an org's own cron and says it is the org's", async () => {
    const { cadence, kept } = cadenceAt("2026-11-11T10:20:00Z");
    const set = await cadence.setSchedule("  0   0 * * * ");
    assert.equal(set.schedule, "0 0 * * *");
    assert.equal(set.source, "org");
    assert.equal(set.nextAtIso, "2026-11-12T00:00:00.000Z");
    assert.equal(kept.row()?.cron, "0 0 * * *");

    const back = await cadence.setSchedule(null);
    assert.equal(back.source, "default");
    assert.equal(back.schedule, "0 * * * *");
    assert.equal(back.nextAtIso, "2026-11-11T11:00:00.000Z");
    assert.equal(kept.row()?.cron, null);
  });

  it("refuses a cron that does not parse or never fires, and keeps what was set", async () => {
    const { cadence, kept } = cadenceAt("2026-11-11T10:20:00Z");
    await cadence.setSchedule("0 0 * * *");
    await assert.rejects(cadence.setSchedule("nonsense"), InvalidEpochCronError);
    await assert.rejects(cadence.setSchedule("0 0 31 2 *"), InvalidEpochCronError);
    assert.equal(kept.row()?.cron, "0 0 * * *");
  });

  it("falls back to hourly when the operator's default never fires", async () => {
    const { cadence } = cadenceAt("2026-11-11T10:20:00Z", { defaultCron: "0 0 31 2 *" });
    assert.equal((await cadence.status()).schedule, "0 * * * *");
  });

  it("tells the next time on the org's clock and stores the wall-clock moment beside it", async () => {
    const { cadence, clock, kept } = cadenceAt("2026-11-11T10:20:00Z");
    clock.offset = 3 * DAY;
    const status = await cadence.status();
    assert.equal(status.nextAtIso, "2026-11-14T11:00:00.000Z");
    assert.equal(status.secondsUntilNext, 40 * 60);
    assert.equal(kept.row()?.dueAt, "2026-11-11T11:00:00.000Z");
  });
});

describe("epoch cadence: the tick", () => {
  it("does not run an epoch that is not due", async () => {
    const { cadence, runs, kept } = cadenceAt("2026-11-11T10:20:00Z");
    // The first look only works the due time out.
    assert.deepEqual(await cadence.runIfDue(), { ran: false });
    assert.equal(kept.row()?.nextAt, "2026-11-11T11:00:00.000Z");
    assert.deepEqual(await cadence.runIfDue(), { ran: false });
    assert.equal(runs(), 0);
  });

  it("runs a due epoch once and moves on to the next match", async () => {
    const { cadence, clock, runs, kept } = cadenceAt("2026-11-11T10:20:00Z");
    await cadence.status();
    clock.wall = at("2026-11-11T11:00:00Z");
    assert.deepEqual(await cadence.runIfDue(), { ran: true });
    assert.equal(kept.row()?.nextAt, "2026-11-11T12:00:00.000Z");
    assert.deepEqual(await cadence.runIfDue(), { ran: false });
    assert.equal(runs(), 1);
  });

  it("runs one epoch for several periods missed at once", async () => {
    const { cadence, clock, runs, kept } = cadenceAt("2026-11-11T10:20:00Z");
    await cadence.status();
    clock.wall = at("2026-11-11T15:30:00Z");
    assert.deepEqual(await cadence.runIfDue(), { ran: true });
    assert.equal(kept.row()?.nextAt, "2026-11-11T16:00:00.000Z");
    assert.equal(runs(), 1);
  });

  it("lets one of two ticks that saw the same epoch due run it", async () => {
    const shared = memoryStore();
    const a = cadenceAt("2026-11-11T10:20:00Z", { store: shared });
    const b = cadenceAt("2026-11-11T10:20:00Z", { store: shared });
    await a.cadence.status();
    a.clock.wall = b.clock.wall = at("2026-11-11T11:00:05Z");
    const results = await Promise.all([a.cadence.runIfDue(), b.cadence.runIfDue()]);
    assert.deepEqual(results.map((r) => r.ran).sort(), [false, true]);
    assert.equal(a.runs() + b.runs(), 1);
  });

  it("counts an epoch that failed as run, and does not retry it until the next period", async () => {
    const kept = memoryStore();
    const clock = { wall: at("2026-11-11T10:20:00Z") };
    let attempts = 0;
    const cadence = createEpochCadence({
      store: kept.store,
      defaultCron: "0 * * * *",
      now: () => clock.wall,
      offset: () => 0,
      run: async () => {
        attempts += 1;
        throw new Error("stream failed");
      },
    });
    await cadence.status();
    clock.wall = at("2026-11-11T11:00:00Z");
    assert.deepEqual(await cadence.runIfDue(), { ran: true });
    assert.deepEqual(await cadence.runIfDue(), { ran: false });
    assert.equal(attempts, 1);
  });

  it("does nothing for an org that is no longer registered", async () => {
    const { cadence, kept, runs } = cadenceAt("2026-11-11T10:20:00Z");
    kept.remove();
    assert.deepEqual(await cadence.runIfDue(), { ran: false });
    assert.equal(runs(), 0);
  });
});

describe("epoch cadence: an org's own clock", () => {
  it("runs the epoch at once when the clock is skipped past it", async () => {
    const { cadence, clock, runs, kept } = cadenceAt("2026-11-11T10:20:00Z");
    const before = await cadence.status();
    clock.offset += before.secondsUntilNext!;
    assert.deepEqual(await cadence.clockMoved("advanced"), { ran: true });
    assert.equal(runs(), 1);
    // The next one is an hour on, on the org's clock; the wall clock has not moved.
    assert.equal(kept.row()?.nextAt, "2026-11-11T12:00:00.000Z");
    assert.equal(kept.row()?.dueAt, "2026-11-11T11:20:00.000Z");
  });

  it("runs it on the next tick when the skip itself was not told to the cadence", async () => {
    const { cadence, clock, runs } = cadenceAt("2026-11-11T10:20:00Z");
    await cadence.status();
    clock.offset += HOUR;
    assert.deepEqual(await cadence.runIfDue(), { ran: true });
    assert.equal(runs(), 1);
  });

  it("brings the wall-clock moment closer when the clock is skipped short of the epoch", async () => {
    const { cadence, clock, runs, kept } = cadenceAt("2026-11-11T10:20:00Z");
    await cadence.status();
    clock.offset += 10 * 60;
    assert.deepEqual(await cadence.clockMoved("advanced"), { ran: false });
    assert.equal(runs(), 0);
    assert.deepEqual(kept.row(), {
      cron: null,
      nextAt: "2026-11-11T11:00:00.000Z",
      dueAt: "2026-11-11T10:50:00.000Z",
    });
    assert.equal((await cadence.status()).secondsUntilNext, 30 * 60);
  });

  it("runs two orgs on different cadences each on its own clock", async () => {
    const hourly = cadenceAt("2026-11-11T10:20:00Z");
    const daily = cadenceAt("2026-11-11T10:20:00Z");
    await hourly.cadence.setSchedule("0 * * * *");
    await daily.cadence.setSchedule("0 0 * * *");

    // An hour skipped in each: only the hourly org's epoch is due.
    hourly.clock.offset += HOUR;
    daily.clock.offset += HOUR;
    assert.deepEqual(await hourly.cadence.clockMoved("advanced"), { ran: true });
    assert.deepEqual(await daily.cadence.clockMoved("advanced"), { ran: false });

    // The daily org skips to its own next pay period; the hourly org is not touched.
    daily.clock.offset += (await daily.cadence.status()).secondsUntilNext!;
    assert.deepEqual(await daily.cadence.clockMoved("advanced"), { ran: true });
    assert.deepEqual(await hourly.cadence.runIfDue(), { ran: false });
    assert.equal(hourly.runs(), 1);
    assert.equal(daily.runs(), 1);
  });

  it("works the next epoch out again from wall time after a reset", async () => {
    const { cadence, clock, kept, runs } = cadenceAt("2026-11-11T10:20:00Z");
    clock.offset = 30 * DAY;
    await cadence.status();
    assert.equal(kept.row()?.nextAt, "2026-12-11T11:00:00.000Z");
    clock.offset = 0;
    assert.deepEqual(await cadence.clockMoved("reset"), { ran: false });
    assert.deepEqual(kept.row(), {
      cron: null,
      nextAt: "2026-11-11T11:00:00.000Z",
      dueAt: "2026-11-11T11:00:00.000Z",
    });
    assert.equal(runs(), 0);
  });
});

describe("processEpochStatus", () => {
  it("tells a process-wide cron's next time on the wall clock", () => {
    assert.deepEqual(processEpochStatus("0 * * * *", Date.parse("2026-11-11T10:20:00Z")), {
      schedule: "0 * * * *",
      source: "process",
      clock: "wall",
      nextAt: at("2026-11-11T11:00:00Z"),
      nextAtIso: "2026-11-11T11:00:00.000Z",
      secondsUntilNext: 40 * 60,
    });
  });

  it("does not guess a next time for an interval or for no schedule", () => {
    for (const schedule of ["interval:5000", null]) {
      const status = processEpochStatus(schedule, Date.parse("2026-11-11T10:20:00Z"));
      assert.equal(status.schedule, schedule);
      assert.equal(status.nextAt, null);
      assert.equal(status.secondsUntilNext, null);
    }
  });
});
