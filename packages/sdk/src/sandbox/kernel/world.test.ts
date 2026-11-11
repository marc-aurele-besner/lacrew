import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { manualClock } from "./clock.js";
import * as escalationRouter from "./escalationRouter.js";
import * as governance from "./governance.js";
import * as orgRegistry from "./orgRegistry.js";
import * as policies from "./policies.js";
import { deserializeWorld, serializeWorld } from "./serialize.js";
import * as sessionRegistry from "./sessionRegistry.js";
import { KEY, ROOT, STRANGER, T0, TARGET, USDC, WORKER, crewOrg } from "./testkit.test.js";
import * as token from "./token.js";
import * as treasury from "./treasury.js";
import { MAX_UINT256, SimRevert, ZERO_ADDRESS } from "./types.js";
import { blankWorld, genesis, simAddress, transact, view } from "./world.js";

describe("kernel genesis", () => {
  const world = genesis({ root: ROOT, at: T0 });
  const a = world.addresses;

  it("is an empty org: one root node, no funds, no other seats", () => {
    assert.deepEqual(world.orgRegistry.nodes, {
      [ROOT]: {
        account: ROOT,
        kind: orgRegistry.NodeKind.HumanRoot,
        parent: ZERO_ADDRESS,
        active: true,
      },
    });
    assert.deepEqual(world.orgRegistry.children, {});
    assert.equal(world.token.totalSupply, 0n);
    assert.deepEqual(world.token.balances, {});
    assert.equal(world.treasury.totalReserved, 0n);
    assert.deepEqual(world.treasury.allowanceBalance, {});
    assert.deepEqual(world.escalationRouter.intents, {});
    assert.deepEqual(world.sessionRegistry.sessions, {});
    assert.deepEqual(world.epochStreamer.recipients, []);
    assert.deepEqual(world.governance.proposals, {});
    assert.deepEqual(world.governance.votingPower, { [ROOT]: 2n });
    const whitelist = world.policies[a.whitelistPolicy] as policies.WhitelistPolicyState;
    assert.deepEqual(whitelist.allowed, {});
  });

  it("wires the contracts to each other the way the reference deploy does", () => {
    assert.equal(world.escalationRouter.policy, a.policyStack);
    assert.equal(world.escalationRouter.treasury, a.treasury);
    assert.equal(world.escalationRouter.rateRecorder, a.rateLimitPolicy);
    assert.equal(world.escalationRouter.sessionRegistry, a.sessionRegistry);
    assert.equal(world.treasury.spender, a.escalationRouter);
    assert.equal(world.treasury.streamer, a.epochStreamer);
    assert.equal(world.treasury.token, a.token);
    assert.equal(world.sessionRegistry.escalationRouter, a.escalationRouter);
    assert.equal(world.sessionRegistry.humanRoot, ROOT);
    assert.equal(world.epochStreamer.operator, ROOT);
    assert.deepEqual((world.policies[a.policyStack] as policies.PolicyStackState).modules, [
      a.timeWindowPolicy,
      a.whitelistPolicy,
      a.spendCapPolicy,
      a.rateLimitPolicy,
    ]);
    assert.deepEqual((world.policies[a.managerPolicyStack] as policies.PolicyStackState).modules, [
      a.whitelistPolicy,
      a.spendCapPolicy,
    ]);
    const rate = world.policies[a.rateLimitPolicy] as policies.RateLimitPolicyState;
    assert.equal(rate.recorder, a.escalationRouter);
    assert.equal(rate.recorderLocked, true);
    const cap = world.policies[a.spendCapPolicy] as policies.SpendCapPolicyState;
    assert.equal(cap.agentCap[ROOT], MAX_UINT256);
  });

  it("hands every contract's authority to the GovernanceModule", () => {
    const gov = a.governanceModule;
    assert.equal(world.orgRegistry.governor, gov);
    assert.equal(world.treasury.governor, gov);
    assert.equal(world.escalationRouter.governor, gov);
    assert.equal(world.epochStreamer.governor, gov);
    assert.equal(
      (world.policies[a.whitelistPolicy] as policies.WhitelistPolicyState).governor,
      gov,
    );
    assert.equal((world.policies[a.spendCapPolicy] as policies.SpendCapPolicyState).governor, gov);
    // The root can no longer write the tree or the router by key.
    assert.throws(
      () =>
        transact(world, { sender: ROOT, at: T0 }, (ctx) =>
          orgRegistry.addNode(ctx, WORKER, 2, ROOT),
        ),
      { errorName: "NotAuthorized" },
    );
    assert.throws(
      () =>
        transact(world, { sender: ROOT, at: T0 }, (ctx) =>
          escalationRouter.setNodePolicy(ctx, WORKER, a.policyStack),
        ),
      { errorName: "NotAuthorized" },
    );
  });

  it("leaves the deployer in charge when governance is not bound", () => {
    const open = genesis({ root: ROOT, at: T0, bindGovernor: false });
    assert.equal(open.orgRegistry.governor, ZERO_ADDRESS);
    assert.equal(open.treasury.governor, ZERO_ADDRESS);
    assert.equal(open.escalationRouter.governor, ZERO_ADDRESS);
  });

  it("gives every contract its own address under the simulated prefix", () => {
    const all = Object.values(a);
    assert.equal(new Set(all).size, all.length);
    for (const address of all) {
      assert.match(address, /^0x5a4d0000[0-9a-f]{32}$/);
    }
    assert.equal(a.token, simAddress(1n));
    assert.equal(world.nonce, BigInt(all.length));
  });

  it("is deterministic", () => {
    assert.deepEqual(genesis({ root: ROOT, at: T0 }), world);
  });
});

describe("kernel transact", () => {
  it("commits to a copy and never touches the world it was given", () => {
    const world = genesis({ root: ROOT, at: T0, bindGovernor: false });
    const before = structuredClone(world);
    const out = transact(world, { sender: ROOT, at: T0 }, (ctx) =>
      orgRegistry.addNode(ctx, WORKER, 2, ROOT),
    );
    assert.deepEqual(world, before);
    assert.ok(out.world.orgRegistry.nodes[WORKER]);
    assert.deepEqual(
      out.events.map((e) => [e.contract, e.name, e.address]),
      [["OrgRegistry", "NodeAdded", world.addresses.orgRegistry]],
    );
  });

  it("a revert midway through a call discards everything the call did", () => {
    const sim = crewOrg();
    const before = structuredClone(sim.world);
    assert.throws(
      () =>
        transact(sim.world, { sender: ROOT, at: sim.now }, (ctx) => {
          orgRegistry.setActive(ctx, WORKER, false);
          token.mint(ctx, STRANGER, 5n);
          throw new SimRevert("Later");
        }),
      { errorName: "Later" },
    );
    assert.deepEqual(sim.world, before);
  });

  it("reads the time from the clock it is given, and from nowhere else", () => {
    const clock = manualClock(Number(T0));
    const world = genesis({ root: ROOT, at: clock, bindGovernor: false });
    const issue = () =>
      transact(world, { sender: ROOT, at: clock }, (ctx) =>
        sessionRegistry.issue(ctx, WORKER, KEY, T0 + 10n, 1n, 1n, ZERO_ADDRESS),
      );
    issue();
    clock.advance(10);
    assert.throws(issue, { errorName: "InvalidExpiry" });
    assert.throws(() => clock.set(Number(T0)), /before its own/);
    assert.throws(() => clock.advance(-1), /non-negative/);
  });

  it("a view keeps nothing it writes", () => {
    const world = genesis({ root: ROOT, at: T0, bindGovernor: false });
    const before = structuredClone(world);
    const liquid = view(world, { sender: STRANGER, at: T0 }, (ctx) => {
      ctx.world.treasury.totalReserved = 99n;
      return treasury.liquidBalance(ctx);
    });
    assert.equal(liquid, 0n);
    assert.deepEqual(world, before);
  });
});

describe("kernel state serialisation", () => {
  /** A world with something in every corner: nodes, funds, a session, an intent, a proposal. */
  function busyWorld() {
    const sim = crewOrg();
    sim.send(ROOT, (ctx) =>
      sessionRegistry.issueScopedTimed(
        ctx,
        WORKER,
        KEY,
        ctx.now + 3_600n,
        3n,
        MAX_UINT256,
        [TARGET],
        0n,
        86_400n,
        5n,
        60n,
      ),
    );
    sim.send(KEY, (ctx) => escalationRouter.propose(ctx, WORKER, TARGET, 10n * USDC, "0x"));
    sim.send(KEY, (ctx) => escalationRouter.propose(ctx, WORKER, TARGET, 75n * USDC, "0xabcd"));
    sim.send(ROOT, (ctx) => governance.propose(ctx, governance.Tier.High, TARGET, "0x01"));
    sim.send(ROOT, (ctx) => governance.vote(ctx, 1n, true));
    return sim.world;
  }

  it("round-trips through JSON text without loss", () => {
    const world = busyWorld();
    const text = JSON.stringify(serializeWorld(world));
    assert.deepEqual(deserializeWorld(JSON.parse(text)), world);
  });

  it("writes every integer as a decimal string and keeps no bigint", () => {
    const json = serializeWorld(busyWorld()) as Record<string, any>;
    assert.equal(json.treasury.totalReserved, (190n * USDC).toString());
    assert.equal(json.nonce, "13");
    assert.equal(json.version, 1);
    assert.equal(json.sessionRegistry.sessions["1"].maxValue, MAX_UINT256.toString());
    assert.equal(json.escalationRouter.intents["1"].data, "0xabcd");
    assert.equal(json.governance.proposals["1"].yesVotes, "2");
    // Enums stay numbers; only uints become strings.
    assert.equal(json.governance.proposals["1"].tier, 1);
  });

  it("round-trips the empty and the blank world", () => {
    for (const world of [blankWorld(), genesis({ root: ROOT, at: T0 })]) {
      assert.deepEqual(deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world)))), world);
    }
  });

  it("refuses a state it could not read back", () => {
    const world = blankWorld();
    (world.orgRegistry as { root: string }).root = "12345";
    assert.throws(() => serializeWorld(world), /digits-only/);
    assert.throws(() => deserializeWorld({ version: 2 }), /version 1/);
  });
});

describe("kernel purity", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("imports nothing but its own files", () => {
    assert.ok(sources.length >= 12);
    for (const file of sources) {
      const text = readFileSync(`${dir}/${file}`, "utf8");
      for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
        assert.match(match[1]!, /^\.\/[a-zA-Z]+\.js$/, `${file} imports ${match[1]}`);
      }
    }
  });

  it("never reads the wall clock", () => {
    for (const file of sources) {
      const text = readFileSync(`${dir}/${file}`, "utf8");
      assert.equal(/Date\.now|new Date|performance\.now/.test(text), false, file);
    }
  });
});
