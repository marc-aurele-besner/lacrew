import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as policies from "./policies.js";
import { Verdict } from "./policies.js";
import { ROOT, STRANGER, Sim, T0, TARGET, WORKER } from "./testkit.test.js";
import { MAX_UINT256, ONE_DAY, ZERO_ADDRESS, type Address } from "./types.js";
import { allocateAddress, blankWorld, type Ctx } from "./world.js";

const ADMIN = `0x${"11".repeat(20)}` as Address;
const GOVERNOR = `0x${"33".repeat(20)}` as Address;
const ROUTER = `0x${"44".repeat(20)}` as Address;
const NOT_A_MODULE = `0x${"55".repeat(20)}` as Address;

/** Deploy one module as ADMIN and return its address. */
function deploy(sim: Sim, make: (ctx: Ctx, address: Address) => void): Address {
  return sim.send(ADMIN, (ctx) => {
    const address = allocateAddress(ctx);
    make(ctx, address);
    return address;
  });
}

const check = (sim: Sim, module: Address, value = 0n, target: Address = TARGET) =>
  sim.read((ctx) => policies.check(ctx, module, WORKER, target, value, "0x"));

describe("kernel SpendCapPolicy", () => {
  it("allows at or under the cap and escalates above it", () => {
    const sim = new Sim(blankWorld());
    const cap = deploy(sim, (ctx, a) => policies.deploySpendCapPolicy(ctx, a, 50n));
    assert.equal(check(sim, cap, 50n), Verdict.ALLOW);
    assert.equal(check(sim, cap, 51n), Verdict.ESCALATE);
    assert.equal(
      sim.read((ctx) => policies.capOf(ctx, cap, WORKER)),
      50n,
    );
  });

  it("an explicit agent cap replaces the default, even when it is zero", () => {
    const sim = new Sim(blankWorld());
    const cap = deploy(sim, (ctx, a) => policies.deploySpendCapPolicy(ctx, a, 50n));
    sim.send(ADMIN, (ctx) => policies.setAgentCap(ctx, cap, WORKER, 0n));
    assert.equal(check(sim, cap, 0n), Verdict.ALLOW);
    assert.equal(check(sim, cap, 1n), Verdict.ESCALATE);
    sim.send(ADMIN, (ctx) => policies.setAgentCap(ctx, cap, WORKER, MAX_UINT256));
    assert.equal(check(sim, cap, MAX_UINT256), Verdict.ALLOW);
    assert.deepEqual(sim.lastEvent("AgentCapSet").args, { agent: WORKER, cap: MAX_UINT256 });
  });

  it("is mutable by the admin and the governor, and the governor binds once", () => {
    const sim = new Sim(blankWorld());
    const cap = deploy(sim, (ctx, a) => policies.deploySpendCapPolicy(ctx, a, 50n));
    sim.reverts("NotAuthorized", STRANGER, (ctx) => policies.setAgentCap(ctx, cap, WORKER, 1n));
    sim.reverts("NotAuthorized", STRANGER, (ctx) => policies.setGovernor(ctx, cap, GOVERNOR));
    sim.reverts("ZeroAddress", ADMIN, (ctx) => policies.setGovernor(ctx, cap, ZERO_ADDRESS));
    sim.send(ADMIN, (ctx) => policies.setGovernor(ctx, cap, GOVERNOR));
    sim.reverts("GovernorAlreadySet", ADMIN, (ctx) => policies.setGovernor(ctx, cap, ROOT));
    sim.send(GOVERNOR, (ctx) => policies.setAgentCap(ctx, cap, WORKER, 7n));
    sim.send(ADMIN, (ctx) => policies.setAgentCap(ctx, cap, WORKER, 8n));
    assert.equal(
      sim.read((ctx) => policies.capOf(ctx, cap, WORKER)),
      8n,
    );
  });
});

describe("kernel WhitelistPolicy", () => {
  it("allows listed targets and denies every other", () => {
    const sim = new Sim(blankWorld());
    const wl = deploy(sim, (ctx, a) => policies.deployWhitelistPolicy(ctx, a));
    assert.equal(check(sim, wl), Verdict.DENY);
    sim.send(ADMIN, (ctx) => policies.setAllowed(ctx, wl, TARGET, true));
    assert.equal(check(sim, wl), Verdict.ALLOW);
    assert.deepEqual(sim.lastEvent("TargetAllowed").args, { target: TARGET, allowed: true });
    sim.send(ADMIN, (ctx) => policies.setAllowed(ctx, wl, TARGET, false));
    assert.equal(check(sim, wl), Verdict.DENY);
  });

  it("is mutable by the admin and the governor only", () => {
    const sim = new Sim(blankWorld());
    const wl = deploy(sim, (ctx, a) => policies.deployWhitelistPolicy(ctx, a));
    sim.reverts("NotAuthorized", STRANGER, (ctx) => policies.setAllowed(ctx, wl, TARGET, true));
    sim.send(ADMIN, (ctx) => policies.setGovernor(ctx, wl, GOVERNOR));
    sim.reverts("GovernorAlreadySet", ADMIN, (ctx) => policies.setGovernor(ctx, wl, ROOT));
    sim.send(GOVERNOR, (ctx) => policies.setAllowed(ctx, wl, TARGET, true));
    assert.equal(check(sim, wl), Verdict.ALLOW);
  });
});

describe("kernel RateLimitPolicy", () => {
  const limited = (sim: Sim) =>
    deploy(sim, (ctx, a) => policies.deployRateLimitPolicy(ctx, a, 2n, 3_600n));

  it("allows until the window holds maxActions, then escalates", () => {
    const sim = new Sim(blankWorld());
    const rl = limited(sim);
    assert.equal(check(sim, rl), Verdict.ALLOW);
    sim.send(ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    assert.equal(check(sim, rl), Verdict.ALLOW);
    sim.send(ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    assert.equal(check(sim, rl), Verdict.ESCALATE);
    assert.deepEqual(sim.world.policies[rl], {
      kind: "RateLimitPolicy",
      maxActions: 2n,
      windowSeconds: 3_600n,
      admin: ADMIN,
      recorder: ZERO_ADDRESS,
      recorderLocked: false,
      windows: { [WORKER]: { windowStart: T0, count: 2n } },
    });
  });

  it("rolls the window over once windowSeconds have passed", () => {
    const sim = new Sim(blankWorld());
    const rl = limited(sim);
    sim.send(ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    sim.send(ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    sim.warp(3_599n);
    assert.equal(check(sim, rl), Verdict.ESCALATE);
    sim.warp(1n);
    assert.equal(check(sim, rl), Verdict.ALLOW);
    sim.send(ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    assert.deepEqual((sim.world.policies[rl] as policies.RateLimitPolicyState).windows[WORKER], {
      windowStart: T0 + 3_600n,
      count: 1n,
    });
  });

  it("counts each agent in its own window", () => {
    const sim = new Sim(blankWorld());
    const rl = limited(sim);
    sim.send(ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    sim.send(ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    assert.equal(
      sim.read((ctx) => policies.check(ctx, rl, ROOT, TARGET, 0n, "0x")),
      Verdict.ALLOW,
    );
  });

  it("binds its recorder once, by the deployer, to a non-zero address", () => {
    const sim = new Sim(blankWorld());
    const rl = limited(sim);
    sim.reverts("NotAuthorized", STRANGER, (ctx) => policies.setRecorder(ctx, rl, STRANGER));
    sim.reverts("ZeroAddress", ADMIN, (ctx) => policies.setRecorder(ctx, rl, ZERO_ADDRESS));
    sim.send(ADMIN, (ctx) => policies.setRecorder(ctx, rl, ROUTER));
    assert.deepEqual(sim.lastEvent("RecorderBound").args, { recorder: ROUTER });
    sim.reverts("RecorderLocked", ADMIN, (ctx) => policies.setRecorder(ctx, rl, STRANGER));
  });

  it("records for the deployer before binding and for the recorder alone after", () => {
    const sim = new Sim(blankWorld());
    const rl = limited(sim);
    sim.reverts("NotRecorder", STRANGER, (ctx) => policies.record(ctx, rl, WORKER));
    sim.send(ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    sim.send(ADMIN, (ctx) => policies.setRecorder(ctx, rl, ROUTER));
    sim.reverts("NotRecorder", ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    sim.send(ROUTER, (ctx) => policies.record(ctx, rl, WORKER));
  });

  it("panics when the window end overflows, as the checked addition does", () => {
    const sim = new Sim(blankWorld());
    const rl = deploy(sim, (ctx, a) => policies.deployRateLimitPolicy(ctx, a, 1n, MAX_UINT256));
    sim.send(ADMIN, (ctx) => policies.record(ctx, rl, WORKER));
    sim.reverts("Panic", STRANGER, (ctx) => policies.check(ctx, rl, WORKER, TARGET, 0n, "0x"));
  });
});

describe("kernel TimeWindowPolicy", () => {
  it("rejects an empty, inverted or over-long window", () => {
    const sim = new Sim(blankWorld());
    const bad = (start: bigint, end: bigint) =>
      sim.reverts("InvalidWindow", ADMIN, (ctx) =>
        policies.deployTimeWindowPolicy(ctx, allocateAddress(ctx), start, end),
      );
    bad(10n, 10n);
    bad(11n, 10n);
    bad(0n, ONE_DAY + 1n);
  });

  it("allows inside [start, end) of the UTC day and denies outside", () => {
    // T0 is 80 000 seconds into its day.
    const sim = new Sim(blankWorld());
    const tw = deploy(sim, (ctx, a) => policies.deployTimeWindowPolicy(ctx, a, 80_000n, 80_010n));
    assert.equal(check(sim, tw), Verdict.ALLOW);
    sim.warp(9n);
    assert.equal(check(sim, tw), Verdict.ALLOW);
    sim.warp(1n);
    assert.equal(check(sim, tw), Verdict.DENY);
    sim.warp(ONE_DAY - 11n);
    assert.equal(check(sim, tw), Verdict.DENY);
    sim.warp(1n);
    assert.equal(check(sim, tw), Verdict.ALLOW);
  });

  it("a full-day window is always open", () => {
    const sim = new Sim(blankWorld());
    const tw = deploy(sim, (ctx, a) => policies.deployTimeWindowPolicy(ctx, a, 0n, ONE_DAY));
    for (let i = 0; i < 5; i++) {
      assert.equal(check(sim, tw), Verdict.ALLOW);
      sim.warp(21_601n);
    }
  });
});

describe("kernel PolicyStack", () => {
  function stackWorld() {
    const sim = new Sim(blankWorld());
    const wl = deploy(sim, (ctx, a) => policies.deployWhitelistPolicy(ctx, a));
    const cap = deploy(sim, (ctx, a) => policies.deploySpendCapPolicy(ctx, a, 50n));
    const stack = (modules: Address[]) =>
      deploy(sim, (ctx, a) => policies.deployPolicyStack(ctx, a, modules));
    return { sim, wl, cap, stack };
  }

  it("cannot be empty", () => {
    const sim = new Sim(blankWorld());
    sim.reverts("EmptyStack", ADMIN, (ctx) =>
      policies.deployPolicyStack(ctx, allocateAddress(ctx), []),
    );
  });

  it("allows only when every module allows", () => {
    const { sim, wl, cap, stack } = stackWorld();
    const s = stack([wl, cap]);
    sim.send(ADMIN, (ctx) => policies.setAllowed(ctx, wl, TARGET, true));
    assert.equal(check(sim, s, 50n), Verdict.ALLOW);
  });

  it("escalates when any module escalates and none denies", () => {
    const { sim, wl, cap, stack } = stackWorld();
    sim.send(ADMIN, (ctx) => policies.setAllowed(ctx, wl, TARGET, true));
    assert.equal(check(sim, stack([wl, cap]), 51n), Verdict.ESCALATE);
    assert.equal(check(sim, stack([cap, wl]), 51n), Verdict.ESCALATE);
  });

  it("a DENY wins wherever it sits, including after an ESCALATE", () => {
    const { sim, wl, cap, stack } = stackWorld();
    assert.equal(check(sim, stack([cap, wl]), 51n), Verdict.DENY);
    assert.equal(check(sim, stack([wl, cap]), 51n), Verdict.DENY);
  });

  it("nests: a stack is itself a module", () => {
    const { sim, wl, cap, stack } = stackWorld();
    sim.send(ADMIN, (ctx) => policies.setAllowed(ctx, wl, TARGET, true));
    const inner = stack([cap]);
    assert.equal(check(sim, stack([wl, inner]), 51n), Verdict.ESCALATE);
  });

  it("reverts without an error when a member, or the module itself, has no code", () => {
    const { sim, cap, stack } = stackWorld();
    const s = stack([cap, NOT_A_MODULE]);
    sim.reverts("EvmRevert", STRANGER, (ctx) => policies.check(ctx, s, WORKER, TARGET, 0n, "0x"));
    sim.reverts("EvmRevert", STRANGER, (ctx) =>
      policies.check(ctx, NOT_A_MODULE, WORKER, TARGET, 0n, "0x"),
    );
    // A module of another kind has no such function either.
    sim.reverts("EvmRevert", ADMIN, (ctx) => policies.setAllowed(ctx, cap, TARGET, true));
    sim.reverts("EvmRevert", ADMIN, (ctx) => policies.record(ctx, cap, WORKER));
  });
});
