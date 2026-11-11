import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cronMatches, isValidCron, nextCronAfter, parseCron } from "./cron.js";
import { flow } from "./builder.js";
import { validateFlow } from "./validate.js";

describe("cron matcher", () => {
  it("validates well-formed expressions", () => {
    for (const expr of [
      "* * * * *",
      "*/5 * * * *",
      "0 9-17 * * 1-5",
      "30 8 1,15 * *",
      "0 0 * * 7",
    ]) {
      assert.ok(isValidCron(expr), expr);
    }
  });

  it("rejects malformed expressions", () => {
    for (const expr of [
      "",
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "a * * * *",
      "*/0 * * * *",
      "5-2 * * * *",
    ]) {
      assert.ok(!isValidCron(expr), expr);
    }
  });

  it("matches minutes, ranges, and steps in UTC", () => {
    const d = new Date(Date.UTC(2026, 6, 20, 9, 30)); // Mon Jul 20 2026 09:30 UTC
    assert.ok(cronMatches("* * * * *", d));
    assert.ok(cronMatches("30 9 * * *", d));
    assert.ok(cronMatches("*/15 9-17 * * 1-5", d));
    assert.ok(!cronMatches("0 9 * * *", d));
    assert.ok(!cronMatches("30 9 * * 0", d));
  });

  it("normalizes dow 7 to Sunday", () => {
    const sunday = new Date(Date.UTC(2026, 6, 19, 0, 0));
    assert.ok(cronMatches("0 0 * * 7", sunday));
    assert.ok(cronMatches("0 0 * * 0", sunday));
    assert.equal(parseCron("bad"), null);
  });
});

describe("nextCronAfter", () => {
  const next = (expr: string, after: string) =>
    nextCronAfter(expr, new Date(after))?.toISOString() ?? null;

  it("finds the next matching minute, strictly after the instant given", () => {
    assert.equal(next("0 * * * *", "2026-11-11T10:20:30Z"), "2026-11-11T11:00:00.000Z");
    assert.equal(next("0 * * * *", "2026-11-11T11:00:00Z"), "2026-11-11T12:00:00.000Z");
    assert.equal(next("*/15 * * * *", "2026-11-11T10:14:59Z"), "2026-11-11T10:15:00.000Z");
    assert.equal(next("* * * * *", "2026-11-11T23:59:10Z"), "2026-11-12T00:00:00.000Z");
  });

  it("crosses days, weeks, months and years", () => {
    assert.equal(next("0 0 * * *", "2026-11-11T00:00:00Z"), "2026-11-12T00:00:00.000Z");
    // 2026-11-11 is a Wednesday; the next Sunday is the 15th.
    assert.equal(next("0 0 * * 0", "2026-11-11T12:00:00Z"), "2026-11-15T00:00:00.000Z");
    assert.equal(next("0 0 1 * *", "2026-11-11T12:00:00Z"), "2026-12-01T00:00:00.000Z");
    assert.equal(next("30 9 1 1 *", "2026-11-11T12:00:00Z"), "2027-01-01T09:30:00.000Z");
    assert.equal(next("0 0 29 2 *", "2026-11-11T12:00:00Z"), "2028-02-29T00:00:00.000Z");
  });

  it("agrees with cronMatches on the minute it names", () => {
    for (const expr of ["*/7 3-5 * * 1-5", "5,35 */6 1,15 * *", "0 0 * * 7"]) {
      const at = nextCronAfter(expr, new Date("2026-11-11T10:20:30Z"));
      assert.ok(at && cronMatches(expr, at), expr);
    }
  });

  it("answers null for an expression that does not parse or never fires", () => {
    assert.equal(next("bad", "2026-11-11T12:00:00Z"), null);
    assert.equal(next("0 0 31 2 *", "2026-11-11T12:00:00Z"), null);
    assert.equal(nextCronAfter("0 * * * *", new Date(Number.NaN)), null);
  });
});

describe("cron trigger validation", () => {
  it("requires a valid schedule for cron flows", () => {
    const def = flow("cron-demo", "Cron demo").model("m1", { prompt: "hi" }).build();
    const bad = validateFlow({ ...def, trigger: "cron" });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors[0]?.includes("cron trigger needs a valid"));

    const good = validateFlow({ ...def, trigger: "cron", schedule: "*/5 * * * *" });
    assert.equal(good.ok, true, JSON.stringify(good));
  });
});
