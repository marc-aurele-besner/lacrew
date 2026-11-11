import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as governance from "./governance.js";
import { ProposalState, SeatRole, Tier } from "./governance.js";
import { MANAGER, ROOT, SECOND_HUMAN, STRANGER, Sim, T0, TARGET, WORKER } from "./testkit.test.js";
import { MAX_UINT256, ONE_DAY, SimRevert, ZERO_ADDRESS, type Address, type Hex } from "./types.js";
import { allocateAddress, blankWorld, inertEnv, transact, type Ctx, type World } from "./world.js";

const HOUR = 3_600n;
const VOTING_PERIOD = 3n * ONE_DAY;
const TIMELOCK = ONE_DAY;

/** Calldata the stub env understands: it runs the named action as the caller. */
const ACTIONS: Record<Hex, (ctx: Ctx) => void> = {
  "0xaa01": (ctx) => governance.admitHuman(ctx, SECOND_HUMAN, 2n),
  "0xaa02": (ctx) => governance.removeHuman(ctx, SECOND_HUMAN),
  "0xaa03": (ctx) => governance.removeHuman(ctx, ROOT),
  "0xaa04": (ctx) => governance.setQuorumYes(ctx, 5n),
  "0xaa05": (ctx) => governance.setVotingPower(ctx, ROOT, 0n, SeatRole.None),
  "0xaa06": (ctx) => governance.setTiming(ctx, HOUR, 0n),
  "0xff00": () => {
    throw new SimRevert("Boom");
  },
};

/** A module deployed alone: `rootPower` 2 unless told otherwise. */
function module(rootPower = 2n): Sim & { calls: Array<{ target: Address; data: Hex }> } {
  const world = transact(blankWorld(), { sender: STRANGER, at: T0 }, (ctx) =>
    governance.deploy(ctx, allocateAddress(ctx), ROOT, rootPower),
  ).world;
  const sim = new Sim(world) as Sim & { calls: Array<{ target: Address; data: Hex }> };
  sim.calls = [];
  sim.env = {
    ...inertEnv,
    dispatch(ctx, target, data) {
      sim.calls.push({ target, data });
      const self = (ctx.world as World).addresses.governanceModule;
      if (target === self) ACTIONS[data]?.(ctx as Ctx);
      else if (data === "0xff00") throw new SimRevert("Boom");
    },
  };
  return sim;
}

const self = (sim: Sim) => sim.world.addresses.governanceModule;
const proposal = (sim: Sim, id: bigint) => sim.read((ctx) => governance.proposals(ctx, id));
const agentSeat = (sim: Sim, voter: Address, power = 1n) =>
  sim.send(ROOT, (ctx) => governance.setVotingPower(ctx, voter, power, SeatRole.Agent));
const low = (sim: Sim, data: Hex = "0x1234", from: Address = ROOT) =>
  sim.send(from, (ctx) => governance.propose(ctx, Tier.Low, TARGET, data));
const high = (sim: Sim, target: Address, data: Hex, from: Address = ROOT) =>
  sim.send(from, (ctx) => governance.propose(ctx, Tier.High, target, data));
const vote = (sim: Sim, voter: Address, id: bigint, support = true) =>
  sim.send(voter, (ctx) => governance.vote(ctx, id, support));
const execute = (id: bigint) => (ctx: Ctx) => governance.execute(ctx, id);

/** Seat a second human by governance, the only way one is seated. */
function admitSecondHuman(sim: Sim): void {
  const id = high(sim, self(sim), "0xaa01");
  vote(sim, ROOT, id);
  sim.send(ROOT, execute(id));
}

describe("kernel GovernanceModule: seats", () => {
  it("seeds the root as a human seat with the given weight", () => {
    const sim = module();
    const g = sim.world.governance;
    assert.equal(g.votingPower[ROOT], 2n);
    assert.equal(g.seatRole[ROOT], SeatRole.Human);
    assert.equal(g.totalVotingPower, 2n);
    assert.equal(g.totalHumanVotingPower, 2n);
    assert.equal(g.humanSeatCount, 1n);
    assert.equal(g.quorumYes, 2n);
    assert.equal(g.quorumHumanYes, 1n);
    assert.equal(g.votingPeriod, VOTING_PERIOD);
    assert.equal(g.highTierTimelock, TIMELOCK);
    assert.equal(g.unanimityFastPath, true);
  });

  it("seeds nobody when the root weight is zero, and the root seats the first human", () => {
    const sim = module(0n);
    assert.equal(sim.world.governance.humanSeatCount, 0n);
    sim.reverts("NotGovernance", STRANGER, (ctx) => governance.admitHuman(ctx, STRANGER, 1n));
    sim.send(ROOT, (ctx) => governance.admitHuman(ctx, SECOND_HUMAN, 3n));
    assert.equal(sim.world.governance.humanSeatCount, 1n);
    assert.deepEqual(sim.lastEvent("HumanAdmitted").args, { human: SECOND_HUMAN, power: 3n });
    // A human is seated now, and it is not the root: the root's direct authority is over.
    sim.reverts("NotGovernance", ROOT, (ctx) => governance.admitHuman(ctx, ROOT, 1n));
    sim.reverts("NotHumanRoot", ROOT, (ctx) => governance.setQuorumYes(ctx, 1n));
  });

  it("the root administers agent seats directly and totals follow", () => {
    const sim = module();
    agentSeat(sim, MANAGER, 1n);
    agentSeat(sim, WORKER, 3n);
    assert.equal(sim.world.governance.totalVotingPower, 6n);
    assert.equal(sim.world.governance.totalHumanVotingPower, 2n);
    assert.equal(sim.world.governance.humanSeatCount, 1n);
    assert.deepEqual(sim.lastEvent("VotingPowerUpdated").args, {
      voter: WORKER,
      power: 3n,
      role: SeatRole.Agent,
    });

    sim.send(ROOT, (ctx) => governance.setVotingPower(ctx, WORKER, 0n, SeatRole.Agent));
    assert.equal(sim.world.governance.totalVotingPower, 3n);
    assert.equal(sim.world.governance.seatRole[WORKER], SeatRole.None);
    sim.reverts("NotHumanRoot", STRANGER, (ctx) =>
      governance.setVotingPower(ctx, WORKER, 1n, SeatRole.Agent),
    );
  });

  it("validates a seat before it checks who is asking", () => {
    const sim = module();
    sim.reverts("ZeroAddress", STRANGER, (ctx) =>
      governance.setVotingPower(ctx, ZERO_ADDRESS, 1n, SeatRole.Agent),
    );
    sim.reverts("InvalidSeatRole", STRANGER, (ctx) =>
      governance.setVotingPower(ctx, WORKER, 1n, SeatRole.None),
    );
    sim.reverts("ZeroAddress", STRANGER, (ctx) => governance.admitHuman(ctx, ZERO_ADDRESS, 1n));
    sim.reverts("ZeroPower", STRANGER, (ctx) => governance.admitHuman(ctx, WORKER, 0n));
    sim.reverts("NotAHumanSeat", ROOT, (ctx) => governance.removeHuman(ctx, WORKER));
  });

  it("no key seats, re-weights or revokes a human: that takes a proposal", () => {
    const sim = module();
    sim.reverts("NotGovernance", ROOT, (ctx) => governance.admitHuman(ctx, SECOND_HUMAN, 2n));
    sim.reverts("NotGovernance", ROOT, (ctx) =>
      governance.setVotingPower(ctx, SECOND_HUMAN, 2n, SeatRole.Human),
    );
    sim.reverts("NotGovernance", ROOT, (ctx) =>
      governance.setVotingPower(ctx, ROOT, 9n, SeatRole.Human),
    );
    sim.reverts("NotGovernance", ROOT, (ctx) =>
      governance.setVotingPower(ctx, ROOT, 1n, SeatRole.Agent),
    );
    sim.reverts("NotGovernance", ROOT, (ctx) => governance.removeHuman(ctx, ROOT));

    admitSecondHuman(sim);
    assert.equal(sim.world.governance.humanSeatCount, 2n);
    assert.equal(sim.world.governance.totalHumanVotingPower, 4n);
    assert.equal(sim.world.governance.seatRole[SECOND_HUMAN], SeatRole.Human);
  });

  it("removes a human seat but never the last one", () => {
    const sim = module();
    const last = high(sim, self(sim), "0xaa03");
    vote(sim, ROOT, last);
    // The module's own revert is swallowed by the low-level call; execute reports ActionFailed.
    const err = sim.reverts("ActionFailed", ROOT, execute(last));
    assert.deepEqual(err.args, { target: self(sim) });
    assert.equal(proposal(sim, last).state, ProposalState.Active);

    admitSecondHuman(sim);
    const remove = high(sim, self(sim), "0xaa02");
    vote(sim, ROOT, remove);
    vote(sim, SECOND_HUMAN, remove);
    sim.send(STRANGER, execute(remove));
    assert.equal(sim.world.governance.humanSeatCount, 1n);
    assert.equal(sim.world.governance.votingPower[SECOND_HUMAN], 0n);
    assert.deepEqual(sim.lastEvent("HumanRemoved").args, { human: SECOND_HUMAN });
  });

  it("the root loses its direct authority with its seat", () => {
    const sim = module();
    admitSecondHuman(sim);
    const id = high(sim, self(sim), "0xaa05");
    vote(sim, ROOT, id);
    vote(sim, SECOND_HUMAN, id);
    sim.send(ROOT, execute(id));
    assert.equal(sim.world.governance.seatRole[ROOT], SeatRole.None);
    sim.reverts("NotHumanRoot", ROOT, (ctx) => governance.setQuorumYes(ctx, 1n));
    sim.reverts("NotHumanRoot", ROOT, (ctx) =>
      governance.setVotingPower(ctx, WORKER, 1n, SeatRole.Agent),
    );
    sim.reverts("NotHumanSeat", ROOT, (ctx) => governance.veto(ctx, 99n));
  });

  it("panics when a seat's weight overflows the total", () => {
    const sim = module();
    sim.reverts("Panic", ROOT, (ctx) =>
      governance.setVotingPower(ctx, WORKER, MAX_UINT256, SeatRole.Agent),
    );
  });
});

describe("kernel GovernanceModule: parameters", () => {
  it("the root tunes quorums, timing and the fast path; strangers do not", () => {
    const sim = module();
    sim.reverts("NotHumanRoot", STRANGER, (ctx) => governance.setQuorumYes(ctx, 1n));
    sim.reverts("NotHumanRoot", STRANGER, (ctx) => governance.setQuorumHumanYes(ctx, 1n));
    sim.reverts("NotHumanRoot", STRANGER, (ctx) => governance.setTiming(ctx, HOUR, 0n));
    sim.reverts("NotHumanRoot", STRANGER, (ctx) => governance.setUnanimityFastPath(ctx, false));
    sim.reverts("ZeroQuorum", ROOT, (ctx) => governance.setQuorumYes(ctx, 0n));
    sim.reverts("ZeroQuorum", ROOT, (ctx) => governance.setQuorumHumanYes(ctx, 0n));

    sim.send(ROOT, (ctx) => governance.setQuorumYes(ctx, 3n));
    sim.send(ROOT, (ctx) => governance.setQuorumHumanYes(ctx, 2n));
    sim.send(ROOT, (ctx) => governance.setUnanimityFastPath(ctx, false));
    assert.equal(sim.world.governance.quorumYes, 3n);
    assert.equal(sim.world.governance.quorumHumanYes, 2n);
    assert.equal(sim.world.governance.unanimityFastPath, false);
  });

  it("bounds the voting period and the timelock", () => {
    const sim = module();
    const bad = (period: bigint, timelock: bigint) =>
      sim.reverts("InvalidTiming", ROOT, (ctx) => governance.setTiming(ctx, period, timelock));
    bad(HOUR - 1n, 0n);
    bad(30n * ONE_DAY + 1n, 0n);
    bad(HOUR, 30n * ONE_DAY + 1n);
    sim.send(ROOT, (ctx) => governance.setTiming(ctx, HOUR, 0n));
    assert.deepEqual(sim.lastEvent("TimingUpdated").args, {
      votingPeriod: HOUR,
      highTierTimelock: 0n,
    });
    const id = high(sim, TARGET, "0x");
    assert.equal(proposal(sim, id).deadline, T0 + HOUR);
    assert.equal(proposal(sim, id).eta, T0 + HOUR);
  });

  it("clamps the effective quorum to the weight actually seated", () => {
    const sim = module(1n);
    sim.send(ROOT, (ctx) => governance.setQuorumHumanYes(ctx, 5n));
    assert.equal(
      sim.read((ctx) => governance.effectiveQuorumYes(ctx)),
      1n,
    );
    assert.equal(
      sim.read((ctx) => governance.effectiveQuorumHumanYes(ctx)),
      1n,
    );
    agentSeat(sim, MANAGER, 4n);
    assert.equal(
      sim.read((ctx) => governance.effectiveQuorumYes(ctx)),
      2n,
    );
  });
});

describe("kernel GovernanceModule: proposals", () => {
  it("binds a proposal to its target and calldata", () => {
    const sim = module();
    const id = low(sim, "0x1234", STRANGER);
    assert.equal(id, 1n);
    assert.deepEqual(proposal(sim, id), {
      proposer: STRANGER,
      tier: Tier.Low,
      target: TARGET,
      actionHash: inertEnv.actionHash(TARGET, "0x1234"),
      data: "0x1234",
      yesVotes: 0n,
      noVotes: 0n,
      yesHumanVotes: 0n,
      deadline: T0 + VOTING_PERIOD,
      eta: 0n,
      state: ProposalState.Active,
    });
    const h = high(sim, TARGET, "0x");
    assert.equal(proposal(sim, h).eta, T0 + VOTING_PERIOD + TIMELOCK);
    assert.equal(sim.lastEvent("ProposalCreated").args.proposalId, 2n);
  });

  it("refuses a zero target, a low-tier self target and a low-tier governor transfer", () => {
    const sim = module();
    sim.reverts("ZeroAddress", ROOT, (ctx) =>
      governance.propose(ctx, Tier.Low, ZERO_ADDRESS, "0x"),
    );
    sim.reverts("SelfTargetNotHighTier", ROOT, (ctx) =>
      governance.propose(ctx, Tier.Low, self(sim), "0x"),
    );
    const setGovernor = `0xc42cf535${"00".repeat(32)}` as Hex;
    sim.reverts("GovernorTransferNotHighTier", ROOT, (ctx) =>
      governance.propose(ctx, Tier.Low, TARGET, setGovernor),
    );
    // The selector alone is enough; fewer than four bytes is not a selector.
    sim.reverts("GovernorTransferNotHighTier", ROOT, (ctx) =>
      governance.propose(ctx, Tier.Low, TARGET, "0xC42CF535"),
    );
    sim.send(ROOT, (ctx) => governance.propose(ctx, Tier.Low, TARGET, "0xc42cf5"));
    sim.send(ROOT, (ctx) => governance.propose(ctx, Tier.High, TARGET, setGovernor));
  });

  it("weighs votes by seat and refuses double votes and seatless voters", () => {
    const sim = module();
    agentSeat(sim, MANAGER, 1n);
    const id = low(sim);
    sim.reverts("NoVotingPower", STRANGER, (ctx) => governance.vote(ctx, id, true));
    vote(sim, ROOT, id);
    sim.reverts("AlreadyVoted", ROOT, (ctx) => governance.vote(ctx, id, false));
    vote(sim, MANAGER, id, false);
    const p = proposal(sim, id);
    assert.equal(p.yesVotes, 2n);
    assert.equal(p.yesHumanVotes, 2n);
    assert.equal(p.noVotes, 1n);
    assert.deepEqual(sim.lastEvent("Voted").args, {
      proposalId: id,
      voter: MANAGER,
      support: false,
      weight: 1n,
    });
    assert.equal(
      sim.read((ctx) => governance.hasVoted(ctx, id, MANAGER)),
      true,
    );
  });

  it("closes voting after the deadline and on proposals that do not exist", () => {
    const sim = module();
    const id = low(sim);
    sim.reverts("ProposalNotActive", ROOT, (ctx) => governance.vote(ctx, 99n, true));
    sim.warp(VOTING_PERIOD);
    vote(sim, ROOT, id);
    const late = low(sim);
    sim.warp(VOTING_PERIOD + 1n);
    sim.reverts("ProposalNotActive", ROOT, (ctx) => governance.vote(ctx, late, true));
  });

  it("executes a low-tier proposal once quorum is met, calling the target as itself", () => {
    const sim = module();
    const id = low(sim, "0x1234");
    sim.reverts("QuorumNotMet", ROOT, execute(id));
    sim.reverts("QuorumNotMet", ROOT, execute(99n));
    vote(sim, ROOT, id);
    sim.send(STRANGER, execute(id));
    assert.equal(proposal(sim, id).state, ProposalState.Executed);
    assert.deepEqual(sim.calls, [{ target: TARGET, data: "0x1234" }]);
    assert.deepEqual(sim.lastEvent("ProposalExecuted").args, { proposalId: id });
    sim.reverts("ProposalNotActive", ROOT, execute(id));
  });

  it("agent yes-weight carries low tier but never high tier", () => {
    const sim = module();
    agentSeat(sim, MANAGER, 5n);
    const lowId = low(sim);
    vote(sim, MANAGER, lowId);
    sim.send(ROOT, execute(lowId));

    const highId = high(sim, TARGET, "0x");
    vote(sim, MANAGER, highId);
    assert.equal(proposal(sim, highId).yesHumanVotes, 0n);
    sim.reverts("QuorumNotMet", ROOT, execute(highId));
  });

  it("holds a high-tier proposal behind its timelock unless every human said yes", () => {
    const sim = module();
    admitSecondHuman(sim);
    const id = high(sim, TARGET, "0x");
    vote(sim, ROOT, id);
    const err = sim.reverts("TimelockNotElapsed", ROOT, execute(id));
    assert.deepEqual(err.args, { proposalId: id, eta: sim.now + VOTING_PERIOD + TIMELOCK });
    sim.warp(VOTING_PERIOD + TIMELOCK - 1n);
    sim.reverts("TimelockNotElapsed", ROOT, execute(id));
    sim.warp(1n);
    sim.send(ROOT, execute(id));
    assert.equal(proposal(sim, id).state, ProposalState.Executed);
  });

  it("skips the timelock on unanimous human yes, unless the fast path is off", () => {
    const sim = module();
    const solo = high(sim, TARGET, "0x");
    vote(sim, ROOT, solo);
    sim.send(ROOT, execute(solo));

    admitSecondHuman(sim);
    const both = high(sim, TARGET, "0x");
    vote(sim, ROOT, both);
    sim.reverts("TimelockNotElapsed", ROOT, execute(both));
    vote(sim, SECOND_HUMAN, both);
    sim.send(ROOT, execute(both));

    sim.send(ROOT, (ctx) => governance.setUnanimityFastPath(ctx, false));
    const slow = high(sim, TARGET, "0x");
    vote(sim, ROOT, slow);
    vote(sim, SECOND_HUMAN, slow);
    sim.reverts("TimelockNotElapsed", ROOT, execute(slow));
  });

  it("any human seat may veto; agents and strangers may not", () => {
    const sim = module();
    agentSeat(sim, MANAGER, 1n);
    admitSecondHuman(sim);
    const id = high(sim, TARGET, "0x");
    sim.reverts("NotHumanSeat", MANAGER, (ctx) => governance.veto(ctx, id));
    sim.reverts("NotHumanSeat", STRANGER, (ctx) => governance.veto(ctx, id));
    sim.send(SECOND_HUMAN, (ctx) => governance.veto(ctx, id));
    assert.equal(proposal(sim, id).state, ProposalState.Vetoed);
    assert.deepEqual(sim.lastEvent("ProposalVetoed").args, {
      proposalId: id,
      vetoer: SECOND_HUMAN,
    });
    sim.reverts("ProposalNotActive", ROOT, (ctx) => governance.veto(ctx, id));
    sim.reverts("ProposalNotActive", ROOT, execute(id));
    sim.reverts("ProposalNotActive", ROOT, (ctx) => governance.vote(ctx, id, true));
  });

  it("a veto of an id not yet created is overwritten when that proposal is", () => {
    const sim = module();
    sim.send(ROOT, (ctx) => governance.veto(ctx, 1n));
    assert.equal(proposal(sim, 1n).state, ProposalState.Vetoed);
    const id = low(sim);
    assert.equal(id, 1n);
    assert.equal(proposal(sim, id).state, ProposalState.Active);
  });

  it("is defeated when no outweighs yes after the deadline", () => {
    const sim = module();
    agentSeat(sim, MANAGER, 3n);
    const id = low(sim);
    vote(sim, ROOT, id);
    vote(sim, MANAGER, id, false);
    sim.warp(VOTING_PERIOD + 1n);
    const mark = sim.events.length;
    sim.send(ROOT, execute(id));
    assert.equal(proposal(sim, id).state, ProposalState.Defeated);
    assert.deepEqual(sim.eventNames(mark), ["ProposalDefeated"]);
    assert.deepEqual(sim.calls, []);
  });

  it("before the deadline, quorum executes even when no outweighs yes", () => {
    const sim = module();
    agentSeat(sim, MANAGER, 3n);
    const id = low(sim);
    vote(sim, ROOT, id);
    vote(sim, MANAGER, id, false);
    sim.send(ROOT, execute(id));
    assert.equal(proposal(sim, id).state, ProposalState.Executed);
  });

  it("a failing action reverts the execution and leaves the proposal active", () => {
    const sim = module();
    const id = low(sim, "0xff00");
    vote(sim, ROOT, id);
    const err = sim.reverts("ActionFailed", ROOT, execute(id));
    assert.deepEqual(err.args, { target: TARGET });
    assert.equal(proposal(sim, id).state, ProposalState.Active);
  });

  it("retunes itself through a high-tier proposal aimed at itself", () => {
    const sim = module();
    const id = high(sim, self(sim), "0xaa04");
    vote(sim, ROOT, id);
    sim.send(STRANGER, execute(id));
    assert.equal(sim.world.governance.quorumYes, 5n);
    const timing = high(sim, self(sim), "0xaa06");
    vote(sim, ROOT, timing);
    sim.send(STRANGER, execute(timing));
    assert.equal(sim.world.governance.votingPeriod, HOUR);
  });
});
