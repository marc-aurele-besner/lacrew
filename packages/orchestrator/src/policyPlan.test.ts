import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { moduleMatchesSpec, planNodeStack, stackUnchanged } from "./policyPlan.js";
import type { NodePolicyStack, PolicyModuleInfo } from "@lacrew/core";

const RATE = {
  address: "0xAaAa000000000000000000000000000000000001",
  kind: "rate_limit",
  maxActions: 5,
  windowSeconds: 86400,
} as PolicyModuleInfo;
const WINDOW = {
  address: "0xBbBb000000000000000000000000000000000002",
  kind: "time_window",
  startSecondOfDay: 21600,
  endSecondOfDay: 79200,
} as PolicyModuleInfo;
const CAP = {
  address: "0xCcCc000000000000000000000000000000000003",
  kind: "spend_cap",
  cap: "50000000",
} as PolicyModuleInfo;

const current: NodePolicyStack = {
  node: "0x1111111111111111111111111111111111111111",
  policyModule: "0xDdDd000000000000000000000000000000000004",
  source: "node",
  modules: [WINDOW, CAP, RATE],
};

describe("planNodeStack", () => {
  it("reuses param-identical rate/window modules from the node's own stack", () => {
    const plan = planNodeStack(
      [
        { kind: "time_window", startSecondOfDay: 21600, endSecondOfDay: 79200 },
        { kind: "spend_cap" },
        { kind: "rate_limit", maxActions: 5, windowSeconds: 86400 },
      ],
      current,
    );
    assert.equal(plan[0]!.reuse, WINDOW.address);
    assert.equal(plan[1]!.reuse, undefined, "shared modules ride the address book, not reuse");
    assert.equal(plan[2]!.reuse, RATE.address);
  });

  it("never reuses a near-match — a different limit is a different module", () => {
    const plan = planNodeStack(
      [{ kind: "rate_limit", maxActions: 5, windowSeconds: 3600 }], // 5/h ≠ 5/d
      current,
    );
    assert.equal(plan[0]!.reuse, undefined);
  });

  it("consumes each existing module at most once", () => {
    const plan = planNodeStack(
      [
        { kind: "rate_limit", maxActions: 5, windowSeconds: 86400 },
        { kind: "rate_limit", maxActions: 5, windowSeconds: 86400 },
      ],
      current,
    );
    assert.equal(plan[0]!.reuse, RATE.address);
    assert.equal(plan[1]!.reuse, undefined, "two identical specs need two modules");
  });

  it("plans all-fresh when the node has no current stack", () => {
    const plan = planNodeStack(
      [{ kind: "time_window", startSecondOfDay: 0, endSecondOfDay: 86400 }],
      undefined,
    );
    assert.equal(plan[0]!.reuse, undefined);
  });
});

describe("stackUnchanged", () => {
  const members = [WINDOW.address, CAP.address, RATE.address] as `0x${string}`[];

  it("recognises an identical per-node binding (case-insensitively)", () => {
    assert.equal(
      stackUnchanged(members.map((m) => m.toUpperCase()) as `0x${string}`[], current),
      true,
    );
  });

  it("treats order as meaningful — the stack evaluates top-down", () => {
    assert.equal(
      stackUnchanged([CAP.address, WINDOW.address, RATE.address] as `0x${string}`[], current),
      false,
    );
  });

  it("still binds when the same composition is only inherited from the default", () => {
    // The operator asked for an explicit binding; inheriting the same modules
    // is a different (weaker) claim, so the proposal still fires.
    assert.equal(stackUnchanged(members, { ...current, source: "default" }), false);
  });

  it("bails to changed on nested stacks rather than trusting flattened identity", () => {
    const nested = {
      ...current,
      modules: [{ address: "0xEe00000000000000000000000000000000000005", kind: "stack" }],
    } as NodePolicyStack;
    assert.equal(stackUnchanged(members, nested), false);
  });
});

describe("moduleMatchesSpec", () => {
  it("never matches shared-module kinds", () => {
    assert.equal(moduleMatchesSpec({ kind: "spend_cap" }, CAP), false);
  });
});
