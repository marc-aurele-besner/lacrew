import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cronMatches, isValidCron, parseCron } from "./cron.js";
import { flow } from "./builder.js";
import { validateFlow } from "./validate.js";

describe("cron matcher", () => {
  it("validates well-formed expressions", () => {
    for (const expr of ["* * * * *", "*/5 * * * *", "0 9-17 * * 1-5", "30 8 1,15 * *", "0 0 * * 7"]) {
      assert.ok(isValidCron(expr), expr);
    }
  });

  it("rejects malformed expressions", () => {
    for (const expr of ["", "* * * *", "60 * * * *", "* 24 * * *", "a * * * *", "*/0 * * * *", "5-2 * * * *"]) {
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
