import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Connector } from "@lacrew/orchestrator";
import { cmdConnectors } from "./connectors.js";

const MERGE_AUTHORITY = "0x00000000000000000000000000000000000000aa";

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
    cmdConnectors(args);
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = process.exitCode;
  process.exitCode = priorCode;
  return { out: out.join("\n"), err: err.join("\n"), code: code as number | undefined };
}

describe("lacrew connectors", () => {
  it("lists the presets that ship, with their credential", () => {
    const { out } = capture(["list"]);
    assert.match(out, /github\s+—\s+GitHub REST API/);
    assert.match(out, /credential: GH_TOKEN/);
  });

  it("shows every route and marks the one that must be admitted", () => {
    const { out } = capture(["show", "github"]);
    assert.match(
      out,
      /read\s+github\.get_pull_request\s+GET \/repos\/\{owner\}\/\{repo\}\/pulls\/\{number\}/,
    );
    assert.match(out, /write\s+github\.merge_pull_request.*needs a policy target/);
    assert.match(out, /--policy-target merge_pull_request=0x…/);
  });

  it("emits config a registry can take", () => {
    const { out, code } = capture([
      "config",
      "github",
      "--policy-target",
      `merge_pull_request=${MERGE_AUTHORITY}`,
    ]);
    assert.equal(code, undefined);
    const parsed = JSON.parse(out) as Connector[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.id, "github");
    const merge = parsed[0]!.routes.find((r) => r.name === "merge_pull_request")!;
    assert.equal(merge.policyTarget, MERGE_AUTHORITY);
  });

  it("refuses to emit a merge route nothing admits", () => {
    const { out, err, code } = capture(["config", "github"]);
    assert.equal(out, "");
    assert.match(err, /connector_preset_unbound_policy_target:github\.merge_pull_request/);
    assert.equal(code, 1);
  });

  it("refuses an address that is not one", () => {
    const { err, code } = capture(["config", "github", "--policy-target", "merge_pull_request=0xzz"]);
    assert.match(err, /is not a 0x address/);
    assert.equal(code, 1);
  });

  it("emits a read-only connector when the write is left out", () => {
    const { out, code } = capture(["config", "github", "--omit", "merge_pull_request"]);
    assert.equal(code, undefined);
    const parsed = JSON.parse(out) as Connector[];
    assert.ok(parsed[0]!.routes.every((r) => r.effect === "read"));
  });

  it("names the known presets when asked for one that does not ship", () => {
    const { err, code } = capture(["show", "bitbucket"]);
    assert.match(err, /Unknown preset "bitbucket"\. Known: github, gitlab/);
    assert.equal(code, 1);
  });

  it("shows what a preset with no default host still needs", () => {
    const { out, code } = capture(["show", "ghost"]);
    assert.equal(code, undefined);
    assert.match(out, /Base URL\s+⚠ none — pass --base-url/);
    assert.match(out, /--base-url https:\/\/…/);
  });

  it("says a public registry needs no credential rather than printing a blank", () => {
    const { out } = capture(["show", "npm"]);
    assert.match(out, /Credential none \(public API\) \(none\)/);
    const { out: json, code } = capture(["config", "npm"]);
    assert.equal(code, undefined);
    const parsed = JSON.parse(json) as Connector[];
    assert.deepEqual(parsed[0]!.auth, { kind: "none" });
  });
});
