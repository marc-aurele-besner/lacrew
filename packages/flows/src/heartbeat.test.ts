import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cronMatchesInZone, cronMinuteGap, zonedParts } from "./cron.js";
import {
  HEARTBEAT_MIN_INTERVAL_MINUTES,
  heartbeatDue,
  heartbeatWindowKey,
  inQuietHours,
  minuteOfDay,
  normalizeHeartbeat,
  validateHeartbeat,
  type CrewHeartbeat,
} from "./heartbeat.js";

const base = (over: Partial<CrewHeartbeat> = {}): CrewHeartbeat =>
  normalizeHeartbeat({
    crewId: "trading",
    schedule: "*/30 * * * *",
    checklist: [{ kind: "flow", id: "risk-sweep" }],
    enabled: true,
    ...over,
  });

describe("cron zone helpers", () => {
  it("reads wall-clock fields in the requested zone", () => {
    // 2026-07-30T12:00Z is 08:00 in New York (EDT, UTC-4).
    const at = new Date("2026-07-30T12:00:00Z");
    assert.deepEqual(zonedParts(at, "America/New_York"), {
      minute: 0,
      hour: 8,
      day: 30,
      month: 7,
      weekday: 4,
    });
  });

  it("reports midnight as hour 0, not 24", () => {
    const at = new Date("2026-07-30T00:00:00Z");
    assert.equal(zonedParts(at, "UTC").hour, 0);
    assert.ok(cronMatchesInZone("0 0 * * *", at, "UTC"));
  });

  it("matches a schedule against local time, not UTC", () => {
    const at = new Date("2026-07-30T13:00:00Z"); // 09:00 in New York
    assert.ok(cronMatchesInZone("0 9 * * *", at, "America/New_York"));
    assert.ok(!cronMatchesInZone("0 9 * * *", at, "UTC"));
  });

  it("derives the densest gap a minute field can produce", () => {
    assert.equal(cronMinuteGap("*/15 * * * *"), 15);
    assert.equal(cronMinuteGap("0 * * * *"), 60);
    assert.equal(cronMinuteGap("* * * * *"), 1);
    // Wraparound: 59 → 0 next hour is one minute apart.
    assert.equal(cronMinuteGap("0,59 * * * *"), 1);
    assert.equal(cronMinuteGap("nonsense"), null);
  });
});

describe("validateHeartbeat", () => {
  it("refuses an enabled heartbeat with an empty checklist", () => {
    const check = validateHeartbeat({ ...base(), checklist: [], enabled: true });
    assert.ok(!check.ok);
    assert.ok(check.errors.some((e) => e.includes("at least one checklist item")));
  });

  it("accepts an empty checklist while the heartbeat is off", () => {
    const check = validateHeartbeat({ ...base(), checklist: [], enabled: false });
    assert.ok(check.ok, check.errors.join("; "));
  });

  it("refuses a cadence below the floor", () => {
    const check = validateHeartbeat({ ...base(), schedule: "*/5 * * * *" });
    assert.ok(!check.ok);
    assert.ok(check.errors.some((e) => e.includes(String(HEARTBEAT_MIN_INTERVAL_MINUTES))));
  });

  it("refuses a malformed schedule, timezone, quiet window and item", () => {
    const check = validateHeartbeat({
      ...base(),
      schedule: "every half hour",
      timezone: "Mars/Olympus",
      quietHours: { start: "22h", end: "07:00" },
      checklist: [{ kind: "flow", id: "" }],
    });
    assert.ok(!check.ok);
    assert.equal(check.errors.length, 4);
  });

  it("refuses a non-address principal", () => {
    const check = validateHeartbeat({ ...base(), principal: "the-trader" });
    assert.ok(!check.ok);
  });

  it("throws rather than storing a half-normalized config", () => {
    assert.throws(
      () => normalizeHeartbeat({ crewId: "x", schedule: "bad", checklist: [], enabled: true }),
      /invalid_heartbeat/,
    );
  });

  it("fills the defaults an operator did not state", () => {
    const config = normalizeHeartbeat({
      crewId: " Trading ",
      schedule: "0 * * * *",
      checklist: [{ kind: "skill", id: "morning-review" }],
    });
    assert.equal(config.crewId, "trading");
    assert.equal(config.notifyOnOk, true);
    assert.equal(config.stopOnError, false);
    // Off by default: a heartbeat that started beating the moment it was typed
    // would spend before anyone read the checklist back.
    assert.equal(config.enabled, false);
  });
});

describe("quiet hours", () => {
  it("parses HH:MM and refuses anything else", () => {
    assert.equal(minuteOfDay("07:30"), 450);
    assert.equal(minuteOfDay("24:00"), null);
    assert.equal(minuteOfDay("7:30"), null);
  });

  it("covers a window that wraps midnight", () => {
    const config = base({ quietHours: { start: "22:00", end: "07:00" } });
    assert.ok(inQuietHours(config, new Date("2026-07-30T23:30:00Z")));
    assert.ok(inQuietHours(config, new Date("2026-07-30T03:00:00Z")));
    assert.ok(!inQuietHours(config, new Date("2026-07-30T12:00:00Z")));
  });

  it("is exact at both boundaries", () => {
    const config = base({ quietHours: { start: "22:00", end: "07:00" } });
    // Start is inclusive, end exclusive — 07:00 is when work resumes.
    assert.ok(inQuietHours(config, new Date("2026-07-30T22:00:00Z")));
    assert.ok(inQuietHours(config, new Date("2026-07-30T06:59:00Z")));
    assert.ok(!inQuietHours(config, new Date("2026-07-30T07:00:00Z")));
    assert.ok(!inQuietHours(config, new Date("2026-07-30T21:59:00Z")));
  });

  it("reads the window in the heartbeat's own zone", () => {
    const config = base({
      timezone: "America/New_York",
      quietHours: { start: "22:00", end: "07:00" },
    });
    // 04:00Z is 00:00 in New York — quiet there, working hours in UTC.
    assert.ok(inQuietHours(config, new Date("2026-07-30T04:00:00Z")));
    assert.ok(!inQuietHours(base({ quietHours: { start: "22:00", end: "07:00" } }),
      new Date("2026-07-30T12:00:00Z")));
  });

  it("treats an empty window as no window, never as a permanent mute", () => {
    const config = base({ quietHours: { start: "09:00", end: "09:00" } });
    assert.ok(!inQuietHours(config, new Date("2026-07-30T09:00:00Z")));
  });
});

describe("heartbeatDue", () => {
  const at = new Date("2026-07-30T14:30:00Z");

  it("fires on a matching minute", () => {
    assert.deepEqual(heartbeatDue(base(), at), { due: true });
  });

  it("skips a disabled heartbeat, an empty one, and an off-schedule minute", () => {
    assert.deepEqual(heartbeatDue(base({ enabled: false }), at), {
      due: false,
      reason: "disabled",
    });
    assert.deepEqual(
      heartbeatDue({ ...base(), checklist: [] }, at),
      { due: false, reason: "empty" },
    );
    assert.deepEqual(heartbeatDue(base(), new Date("2026-07-30T14:31:00Z")), {
      due: false,
      reason: "not-scheduled",
    });
  });

  it("skips quiet hours and resumes at the next window outside them", () => {
    const config = base({
      schedule: "0 * * * *",
      quietHours: { start: "22:00", end: "07:00" },
    });
    assert.deepEqual(heartbeatDue(config, new Date("2026-07-30T23:00:00Z")), {
      due: false,
      reason: "quiet",
    });
    assert.deepEqual(heartbeatDue(config, new Date("2026-07-30T07:00:00Z")), { due: true });
  });
});

describe("heartbeatWindowKey", () => {
  it("is stable within a minute and changes with it", () => {
    const config = base();
    const a = heartbeatWindowKey(config, new Date("2026-07-30T14:30:00Z"));
    const b = heartbeatWindowKey(config, new Date("2026-07-30T14:30:59Z"));
    const c = heartbeatWindowKey(config, new Date("2026-07-30T14:31:00Z"));
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(a.startsWith("trading@"));
  });
});
