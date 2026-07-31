import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cmdEval } from "./evals.js";

/** Capture both streams: a failing suite prints its diffs, and the exit code matters. */
async function run(
  args: string[],
  scope: "flows" | "crews" = "flows",
): Promise<{
  out: string;
  code: number | undefined;
}> {
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => out.push(parts.join(" "));
  process.exitCode = undefined;
  try {
    await cmdEval(args, scope);
  } finally {
    console.log = log;
    console.error = err;
  }
  const code = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join("\n"), code: code as number | undefined };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("lacrew flows eval", () => {
  it("runs the whole suite green and reports coverage", async () => {
    const { out, code } = await run([]);
    assert.match(out, /scenarios green\./);
    assert.doesNotMatch(out, /^✗/m);
    assert.match(out, /first-party flow\(s\) have no eval/);
    assert.equal(
      code,
      undefined,
      "a green suite must not set a failing exit code",
    );
  });

  it("filters by blueprint, and drops the coverage warning when it does", async () => {
    const { out, code } = await run(["github-experts"]);
    assert.match(out, /github-experts\/merge-refused/);
    assert.doesNotMatch(out, /lp-advisor/);
    // Coverage over a filtered run would read as "these flows have no eval"
    // when they simply were not run.
    assert.doesNotMatch(out, /have no eval/);
    assert.equal(code, undefined);
  });

  it("filters by flow id", async () => {
    const { out } = await run(["lp-range-review"]);
    assert.match(out, /lp-advisor\/advice-never-executes/);
    assert.doesNotMatch(out, /bot-pr-triage/);
  });

  it("lists scenarios without running them", async () => {
    const { out } = await run(["--list"]);
    assert.match(
      out,
      /github-experts\/merge-refused {2}· bot-pr-triage · github-experts · as reviewer/,
    );
    assert.doesNotMatch(out, /scenarios green/);
  });

  it("prints machine-readable results under --json", async () => {
    const { out } = await run(["github-experts/merge-refused", "--json"]);
    const parsed = JSON.parse(out) as {
      ok: boolean;
      results: Array<{ id: string; calls: string[] }>;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.results.length, 1);
    assert.ok(parsed.results[0]!.calls.includes("github.get_pull_request"));
    // The assertion the scenario exists for, visible in the machine output too.
    assert.ok(!parsed.results[0]!.calls.includes("github.merge_pull_request"));
  });

  it("exits non-zero and names the suite when a ref matches nothing", async () => {
    const { out, code } = await run(["no-such-crew"]);
    assert.match(out, /No scenario matches "no-such-crew"/);
    assert.match(out, /lacrew flows eval --list/);
    assert.equal(code, 1);
  });

  it("names the crews command when invoked from that noun", async () => {
    const { out } = await run(["no-such-crew"], "crews");
    assert.match(out, /lacrew crews eval --list/);
  });
});
