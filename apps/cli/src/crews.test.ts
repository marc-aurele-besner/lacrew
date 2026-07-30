import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CrewPlanStep } from "@lacrew/flows";
import { cmdCrews } from "./crews.js";

const tmp = mkdtempSync(join(tmpdir(), "lacrew-crews-"));

/** Run a command with stdout captured, so assertions read what a user reads. */
function capture(args: string[]): { out: string; err: string; code: number | undefined } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const priorCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    cmdCrews(args);
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = process.exitCode;
  process.exitCode = priorCode;
  return { out: out.join("\n"), err: err.join("\n"), code: code as number | undefined };
}

describe("lacrew crews", () => {
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists the blueprints with their shape", () => {
    const { out } = capture(["list"]);
    for (const id of ["defi-desk", "github-experts", "content-studio"]) {
      assert.match(out, new RegExp(id));
    }
    assert.match(out, /seats · \d+ flows/);
  });

  it("shows the org chart, the ladder, and what is not enforced", () => {
    const { out } = capture(["show", "content-studio"]);
    assert.match(out, /Editor manager/);
    assert.match(out, /Social desk/);
    assert.match(out, /deny {2}Publishing endpoint/);
    assert.match(out, /Must never happen/);
    assert.match(out, /residual:/);
    assert.match(out, /Outside LaCrew's reach/);
    // The blueprint validates, so no failure block is printed.
    assert.doesNotMatch(out, /does not validate/);
  });

  it("refuses an unknown blueprint instead of printing an empty one", () => {
    const { err, code } = capture(["show", "not-a-crew"]);
    assert.match(err, /defi-desk/);
    assert.equal(code, 1);
  });

  it("plans in dependency order and names every unbound address", () => {
    const { out } = capture(["plan", "defi-desk"]);
    assert.match(out, /Nothing here has been called/);
    assert.ok(
      out.indexOf("Hire Risk manager") < out.indexOf("Hire Executor"),
      "a report cannot be hired before its manager",
    );
    assert.match(out, /needs: crew.root/);
    assert.match(out, /still unbound/);
  });

  it("stops reporting unbound addresses once they are bound", () => {
    const args = ["plan", "github-experts"];
    for (const [role, addr] of [
      ["root", "0x0000000000000000000000000000000000000001"],
      ["review-lead", "0x0000000000000000000000000000000000000002"],
      ["watcher", "0x0000000000000000000000000000000000000003"],
      ["reviewer", "0x0000000000000000000000000000000000000004"],
      ["merger", "0x0000000000000000000000000000000000000005"],
      ["fixer", "0x0000000000000000000000000000000000000006"],
      ["release-scribe", "0x0000000000000000000000000000000000000007"],
      ["target:model-api", "0x0000000000000000000000000000000000000008"],
      ["target:ci-minutes", "0x0000000000000000000000000000000000000009"],
      ["target:sandbox-runner", "0x000000000000000000000000000000000000000a"],
      ["target:merge-authority", "0x000000000000000000000000000000000000000b"],
    ] as const) {
      args.push("--bind", `${role}=${addr}`);
    }
    const { out } = capture(args);
    assert.match(out, /Every address is bound/);
    assert.doesNotMatch(out, /needs:/);
  });

  it("shows the certified first run, who it runs as, and what to wire first", () => {
    const { out } = capture(["show", "github-experts"]);
    assert.match(out, /First run/);
    assert.match(out, /bot-pr-triage · runs as Reviewer/);
    assert.match(out, /Wire first: a model provider key, the github connector/);
  });

  it("says a blueprint has no certified sample rather than omitting the section", () => {
    const { out } = capture(["show", "research-desk"]);
    assert.match(out, /First run/);
    assert.match(out, /No certified sample ships/);
  });

  it("emits the sample input alone so it can be piped into a run", () => {
    const { out } = capture(["sample", "github-experts", "--json"]);
    assert.deepEqual(JSON.parse(out), {
      owner: "marc-aurele-besner",
      repo: "lacrew",
      number: 94,
    });
  });

  // A script asking for an input and getting an empty body must stop, not run
  // a flow with nothing in it.
  it("exits non-zero for a blueprint with no sample", () => {
    const { err, code } = capture(["sample", "research-desk", "--json"]);
    assert.match(err, /No certified sample run ships/);
    assert.equal(code, 1);
  });

  it("writes the plan as JSON when asked", () => {
    const file = join(tmp, "plan.json");
    const { out } = capture(["plan", "content-studio", "--out", file]);
    assert.match(out, /plan steps →/);
    const plan = JSON.parse(readFileSync(file, "utf8")) as CrewPlanStep[];
    assert.ok(plan.length > 0);
    assert.deepEqual(
      plan.map((s) => s.order),
      plan.map((_s, i) => i + 1),
    );
    assert.ok(plan.some((s) => s.kind === "install-flow" && s.via === "http"));
  });
});
