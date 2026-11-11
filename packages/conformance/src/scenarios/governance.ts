/**
 * Governance: an org whose every contract answers to the GovernanceModule, as
 * a deployed one does. Nothing here is done by key that a proposal must do.
 */

import {
  DAY,
  HIGH,
  HOUR,
  KIND,
  LOW,
  SEAT,
  USDC,
  governed,
  type CallSpec,
  type Scenario,
} from "../scenario.js";

const hire = (account: string, kind: number, parent: string): CallSpec => ({
  to: "@registry",
  fn: "addNode",
  args: [account, kind, parent],
});
const whitelist = (target: string, allowed = true): CallSpec => ({
  to: "@whitelist",
  fn: "setAllowed",
  args: [target, allowed],
});

export const governanceScenarios: Scenario[] = [
  governed("a hire is proposed, voted and executed", (b) => {
    // The root cannot write the tree by key once governance is bound.
    b.reverts("NotAuthorized", "root", "@registry", "addNode", ["manager", KIND.manager, "root"]);

    const p = b.propose("stranger", LOW, hire("manager", KIND.manager, "root"));
    b.expect({ proposals: { [p]: { state: "active", yesVotes: 0 } } });
    b.reverts("QuorumNotMet", "root", "@gov", "execute", [BigInt(p)]);
    b.reverts("NoVotingPower", "stranger", "@gov", "vote", [BigInt(p), true]);
    b.vote("root", p, true, { events: ["Voted"] });
    b.reverts("AlreadyVoted", "root", "@gov", "vote", [BigInt(p), false]);
    // Anyone may execute what the electorate has passed.
    b.execute("stranger", p, { events: ["NodeAdded", "ProposalExecuted"] });
    b.expect({
      proposals: { [p]: { state: "executed", yesVotes: 2, noVotes: 0 } },
      nodes: { manager: { parent: "root", kind: "manager_agent" } },
    });

    b.reverts("ProposalNotActive", "root", "@gov", "execute", [BigInt(p)]);
    b.reverts("ProposalNotActive", "root", "@gov", "vote", [BigInt(p), true]);
    // An id nobody proposed: no votes to count, and a deadline long past.
    b.reverts("QuorumNotMet", "root", "@gov", "execute", [99n]);
    b.reverts("ProposalNotActive", "root", "@gov", "vote", [99n, true]);
    // A veto has to name a proposal that exists: an id not yet created is refused.
    b.reverts("ProposalNotFound", "root", "@gov", "veto", [BigInt(p + 1)]);
    b.reverts("ProposalNotFound", "root", "@gov", "veto", [0n]);
    const next = b.propose("root", LOW, hire("worker", KIND.worker, "manager"));
    b.expect({ proposals: { [next]: { state: "active" } } });
  }),

  governed("the governance actions an org is run by", (b) => {
    b.pass(hire("manager", KIND.manager, "root"));
    b.pass(hire("worker", KIND.worker, "manager"));
    b.pass(whitelist("target"), HIGH);
    b.pass({ to: "@spendCap", fn: "setAgentCap", args: ["manager", 200n * USDC] }, HIGH);
    b.pass({ to: "@router", fn: "setNodePolicy", args: ["manager", "@managerStack"] }, HIGH);
    b.pass({ to: "@streamer", fn: "setGrant", args: ["worker", 200n * USDC] }, HIGH);
    b.fund(10_000n * USDC);
    b.call("root", "@streamer", "runNextEpoch");
    b.expect({
      tree: ["root", "manager", "worker"],
      allowance: { worker: 200n * USDC },
      caps: { manager: 200n * USDC, worker: 50n * USDC },
      grants: { worker: 200n * USDC },
    });

    // The org now spends exactly as one built by key does.
    b.allow("worker", "worker", "target", 40n * USDC);
    const intent = b.escalate("worker", "worker", "target", 75n * USDC);
    b.resolve("manager", intent, true);
    b.expect({ allowance: { worker: 85n * USDC }, balance: { target: 115n * USDC } });

    b.pass(
      {
        to: "@streamer",
        fn: "setGrants",
        args: [
          ["worker", "manager"],
          [300n * USDC, 20n * USDC],
        ],
      },
      HIGH,
    );
    b.expect({ grants: { worker: 300n * USDC, manager: 20n * USDC } });

    // A node's own stack: deployed by anyone, bound only by proposal.
    b.deploy("root", "RateLimitPolicy", "rl", [1n, BigInt(HOUR)]);
    b.call("root", "$rl", "setRecorder", ["@router"]);
    b.deploy("root", "PolicyStack", "stack", [["@whitelist", "@spendCap", "$rl"]]);
    b.pass({ to: "@router", fn: "setNodePolicy", args: ["worker", "$stack"] }, HIGH);
    b.pass({ to: "@router", fn: "setNodeRateRecorder", args: ["worker", "$rl"] }, HIGH);
    b.allow("worker", "worker", "target", 1n);
    b.escalate("worker", "worker", "target", 1n);

    b.pass({ to: "@registry", fn: "setActive", args: ["worker", false] });
    b.proposeReverts("InactiveAgent", "worker", "worker", "target", 1n);
    b.pass({ to: "@registry", fn: "setActive", args: ["worker", true] });
    b.pass({ to: "@registry", fn: "reparent", args: ["worker", "root"] });
    b.pass({ to: "@registry", fn: "removeNode", args: ["manager"] });
    b.expect({ tree: ["root", "worker"], nodes: { worker: { parent: "root", active: true } } });

    // A proposal may call an address that holds no contract; the call succeeds.
    const external = b.propose("root", LOW, { to: "target", data: "0x1234" });
    b.vote("root", external);
    b.execute("root", external, { events: ["ProposalExecuted"] });
    b.expect({ proposals: { [external]: { state: "executed" } } });
  }),

  governed("two humans: the timelock, the veto and the unanimity fast path", (b) => {
    // A solo root is the whole human electorate, so its yes is unanimous.
    b.pass({ to: "@gov", fn: "admitHuman", args: ["human2", 2n] }, HIGH);
    b.expect({
      seats: { human2: { power: 2n, role: "human" }, root: { power: 2n, role: "human" } },
      governance: { humanSeatCount: 2n },
    });

    // One human's yes meets quorum but not unanimity: the timelock holds.
    const slow = b.propose("root", HIGH, whitelist("target"));
    b.vote("root", slow);
    b.reverts("TimelockNotElapsed", "root", "@gov", "execute", [BigInt(slow)]);
    b.warp(3 * DAY + DAY - 10);
    b.reverts("TimelockNotElapsed", "root", "@gov", "execute", [BigInt(slow)]);
    b.warp(10);
    b.execute("root", slow);
    b.expect({
      verdicts: [
        { agent: "root", target: "target", value: 0n, verdict: "ALLOW", module: "@whitelist" },
      ],
    });

    // Both humans' yes skips it.
    const fast = b.propose("human2", HIGH, whitelist("target2"));
    b.vote("root", fast);
    b.vote("human2", fast);
    b.execute("stranger", fast);

    // Either human may veto; nobody else may.
    b.call("root", "@gov", "setVotingPower", ["manager", 1n, SEAT.agent]);
    const vetoed = b.propose("root", HIGH, whitelist("stranger"));
    b.reverts("NotHumanSeat", "stranger", "@gov", "veto", [BigInt(vetoed)]);
    b.reverts("NotHumanSeat", "manager", "@gov", "veto", [BigInt(vetoed)]);
    b.veto("human2", vetoed, { events: ["ProposalVetoed"] });
    b.expect({ proposals: { [vetoed]: { state: "vetoed" } } });
    b.reverts("ProposalNotActive", "root", "@gov", "veto", [BigInt(vetoed)]);
    b.reverts("ProposalNotActive", "root", "@gov", "execute", [BigInt(vetoed)]);
    b.reverts("ProposalNotActive", "root", "@gov", "vote", [BigInt(vetoed), true]);

    // Agent yes-weight never satisfies high tier.
    const agentOnly = b.propose("manager", HIGH, whitelist("manager"));
    b.vote("manager", agentOnly);
    b.reverts("QuorumNotMet", "root", "@gov", "execute", [BigInt(agentOnly)]);

    // The fast path is itself a parameter governance can turn off.
    b.pass({ to: "@gov", fn: "setUnanimityFastPath", args: [false] }, HIGH, ["root", "human2"]);
    b.expect({ governance: { unanimityFastPath: false } });
    const noFastPath = b.propose("root", HIGH, whitelist("worker"));
    b.vote("root", noFastPath);
    b.vote("human2", noFastPath);
    b.reverts("TimelockNotElapsed", "root", "@gov", "execute", [BigInt(noFastPath)]);
  }),

  governed("what a proposal may be, and who may change the electorate", (b) => {
    b.reverts("ZeroAddress", "root", "@gov", "propose", [LOW, "zero", "0x"]);
    b.reverts("SelfTargetNotHighTier", "root", "@gov", "propose", [
      LOW,
      "@gov",
      { call: { to: "@gov", fn: "setQuorumYes", args: [1n] } },
    ]);
    b.reverts("GovernorTransferNotHighTier", "root", "@gov", "propose", [
      LOW,
      "@registry",
      { call: { to: "@registry", fn: "setGovernor", args: ["root"] } },
    ]);

    // No key seats, re-weights or revokes a human.
    b.reverts("NotGovernance", "root", "@gov", "admitHuman", ["human2", 2n]);
    b.reverts("NotGovernance", "root", "@gov", "setVotingPower", ["human2", 2n, SEAT.human]);
    b.reverts("NotGovernance", "root", "@gov", "setVotingPower", ["root", 9n, SEAT.human]);
    b.reverts("NotGovernance", "root", "@gov", "setVotingPower", ["root", 0n, SEAT.none]);
    b.reverts("NotGovernance", "root", "@gov", "removeHuman", ["root"]);
    b.reverts("NotAHumanSeat", "root", "@gov", "removeHuman", ["stranger"]);
    b.reverts("ZeroPower", "root", "@gov", "admitHuman", ["human2", 0n]);
    b.reverts("ZeroAddress", "root", "@gov", "admitHuman", ["zero", 1n]);
    b.reverts("ZeroAddress", "root", "@gov", "setVotingPower", ["zero", 1n, SEAT.agent]);
    b.reverts("InvalidSeatRole", "root", "@gov", "setVotingPower", ["manager", 1n, SEAT.none]);

    // The root tunes agent seats and parameters directly; strangers do not.
    b.reverts("NotHumanRoot", "stranger", "@gov", "setVotingPower", ["manager", 1n, SEAT.agent]);
    b.reverts("NotHumanRoot", "stranger", "@gov", "setQuorumYes", [1n]);
    b.reverts("NotHumanRoot", "stranger", "@gov", "setQuorumHumanYes", [1n]);
    b.reverts("NotHumanRoot", "stranger", "@gov", "setTiming", [BigInt(HOUR), 0n]);
    b.reverts("NotHumanRoot", "stranger", "@gov", "setUnanimityFastPath", [false]);
    b.reverts("ZeroQuorum", "root", "@gov", "setQuorumYes", [0n]);
    b.reverts("ZeroQuorum", "root", "@gov", "setQuorumHumanYes", [0n]);
    b.reverts("InvalidTiming", "root", "@gov", "setTiming", [BigInt(HOUR - 1), 0n]);
    b.reverts("InvalidTiming", "root", "@gov", "setTiming", [BigInt(30 * DAY + 1), 0n]);
    b.reverts("InvalidTiming", "root", "@gov", "setTiming", [BigInt(HOUR), BigInt(30 * DAY + 1)]);

    b.call("root", "@gov", "setVotingPower", ["manager", 3n, SEAT.agent], {
      events: ["VotingPowerUpdated"],
    });
    b.call("root", "@gov", "setQuorumYes", [2n], { events: ["QuorumYesUpdated"] });
    // Asking for more human weight than is seated clamps to what is seated.
    b.call("root", "@gov", "setQuorumHumanYes", [5n]);
    // Both bounds are inclusive.
    b.call("root", "@gov", "setTiming", [BigInt(30 * DAY), BigInt(30 * DAY)]);
    b.call("root", "@gov", "setTiming", [BigInt(HOUR), 0n], { events: ["TimingUpdated"] });
    b.expect({
      seats: { manager: { power: 3n, role: "agent" } },
      governance: { humanSeatCount: 1n, quorumYes: 2n },
    });

    // The last human seat cannot be revoked. The module's own refusal is swallowed
    // by the low-level call, so the execution reports ActionFailed.
    const lastHuman = b.propose("root", HIGH, { to: "@gov", fn: "removeHuman", args: ["root"] });
    b.vote("root", lastHuman);
    b.execute("root", lastHuman, { revert: "ActionFailed" }, ["GovernanceModule.LastHumanSeat"]);
    b.expect({ proposals: { [lastHuman]: { state: "active" } } });

    // Calldata no function answers fails the same way.
    const garbage = b.propose("root", LOW, { to: "@registry", data: "0xdeadbeef" });
    b.vote("root", garbage);
    b.execute("root", garbage, { revert: "ActionFailed" });

    // Before the deadline quorum executes even when no outweighs yes; after it, the proposal is defeated.
    const early = b.propose("root", LOW, { to: "target", data: "0x" });
    b.vote("root", early);
    b.vote("manager", early, false);
    b.execute("root", early, { events: ["ProposalExecuted"] });
    const late = b.propose("root", LOW, { to: "target", data: "0x" });
    b.vote("root", late);
    b.vote("manager", late, false);
    b.warp(HOUR + 1);
    b.reverts("ProposalNotActive", "stranger", "@gov", "vote", [BigInt(late), true]);
    b.execute("root", late, { events: ["ProposalDefeated"] });
    b.expect({
      proposals: {
        [early]: { state: "executed", yesVotes: 2, noVotes: 3 },
        [late]: { state: "defeated" },
      },
    });

    // An agent seat is revoked by setting its weight to zero.
    b.call("root", "@gov", "setVotingPower", ["manager", 0n, SEAT.agent]);
    b.expect({ seats: { manager: { power: 0n, role: "none" } } });
  }),

  governed(
    "governance clocks: the voting deadline, the timelock and defeat, to the second",
    (b) => {
      b.pass({ to: "@gov", fn: "admitHuman", args: ["human2", 2n] }, HIGH);
      b.call("root", "@gov", "setVotingPower", ["manager", 5n, SEAT.agent]);

      // Created at second C: voting closes after C + 3 days, the timelock lifts at C + 4 days.
      const p = b.propose("root", HIGH, whitelist("target"));
      b.vote("root", p);
      b.warp(3 * DAY - 2);
      // C + 3 days: the deadline itself still takes a vote.
      b.vote("manager", p, false);
      // C + 3 days + 1: one second later it does not.
      b.reverts("ProposalNotActive", "human2", "@gov", "vote", [BigInt(p), true]);
      b.reverts("TimelockNotElapsed", "root", "@gov", "execute", [BigInt(p)]);
      b.warp(DAY - 2);
      // C + 4 days - 1: the last second of the timelock.
      b.reverts("TimelockNotElapsed", "root", "@gov", "execute", [BigInt(p)]);
      b.warp(1);
      // C + 4 days: the timelock is over, and the tally is read. The agent seat's
      // no outweighs the human yes, but high tier counts human weight alone.
      b.execute("root", p);
      b.expect({ proposals: { [p]: { state: "executed", yesVotes: 2, noVotes: 5 } } });

      // Defeat needs the deadline to have passed: at the deadline itself, quorum still executes.
      const first = b.propose("root", LOW, { to: "target", data: "0x" });
      const second = b.propose("root", LOW, { to: "target", data: "0x" });
      for (const id of [first, second]) {
        b.vote("root", id);
        b.vote("manager", id, false);
      }
      // `first` was created at second D and `second` at D + 1; the clock is at D + 5.
      b.warp(3 * DAY - 5);
      // D + 3 days + 1 is `second`'s deadline: not past it.
      b.execute("root", second, { events: ["ProposalExecuted"] });
      // D + 3 days + 2 is past `first`'s.
      b.execute("root", first, { events: ["ProposalDefeated"] });
      b.expect({ proposals: { [first]: { state: "defeated" }, [second]: { state: "executed" } } });
    },
  ),

  governed("high tier is decided by human weight alone, for and against", (b) => {
    b.pass({ to: "@gov", fn: "admitHuman", args: ["human2", 1n] }, HIGH);
    b.call("root", "@gov", "setVotingPower", ["manager", 5n, SEAT.agent]);

    // The humans back it and the agent seat votes it down.
    const backed = b.propose("root", HIGH, whitelist("target"));
    b.vote("root", backed);
    b.vote("manager", backed, false);
    // The humans vote it down and the agent seat backs it.
    const refused = b.propose("root", HIGH, whitelist("target2"));
    b.vote("human2", refused);
    b.vote("root", refused, false);
    b.vote("manager", refused);

    b.warp(4 * DAY);
    b.execute("stranger", backed, { events: ["TargetAllowed", "ProposalExecuted"] });
    b.execute("stranger", refused, { events: ["ProposalDefeated"] });
    b.expect({
      proposals: {
        [backed]: { state: "executed", yesVotes: 2, noVotes: 5 },
        [refused]: { state: "defeated", yesVotes: 6, noVotes: 2 },
      },
      verdicts: [
        { agent: "root", target: "target", value: 0n, verdict: "ALLOW", module: "@whitelist" },
        { agent: "root", target: "target2", value: 0n, verdict: "DENY", module: "@whitelist" },
      ],
    });
  }),

  governed("quorum is a weight, met exactly, and never more than is seated", (b) => {
    b.call("root", "@gov", "setVotingPower", ["manager", 1n, SEAT.agent]);
    b.call("root", "@gov", "setQuorumYes", [3n]);
    const p = b.propose("root", LOW, hire("worker", KIND.worker, "root"));
    b.vote("root", p);
    b.reverts("QuorumNotMet", "root", "@gov", "execute", [BigInt(p)]);
    b.vote("manager", p);
    b.execute("root", p);

    // Ten is more weight than exists: the bar is what is seated, three.
    b.call("root", "@gov", "setQuorumYes", [10n]);
    const clamped = b.propose("root", LOW, hire("worker2", KIND.worker, "root"));
    b.vote("root", clamped);
    b.reverts("QuorumNotMet", "root", "@gov", "execute", [BigInt(clamped)]);
    b.vote("manager", clamped);
    b.execute("root", clamped);

    // The human quorum is the root's own weight, exactly.
    b.call("root", "@gov", "setQuorumHumanYes", [2n]);
    b.pass(whitelist("target"), HIGH);
    b.expect({ tree: ["root", "worker", "worker2"], governance: { quorumYes: 10n } });
  }),

  governed("a human seat is removed by the humans who remain", (b) => {
    b.pass({ to: "@gov", fn: "admitHuman", args: ["human2", 2n] }, HIGH);
    b.pass({ to: "@gov", fn: "removeHuman", args: ["human2"] }, HIGH, ["root", "human2"]);
    b.expect({
      seats: { human2: { power: 0n, role: "none" } },
      governance: { humanSeatCount: 1n },
    });
    const later = b.propose("human2", LOW, hire("manager", KIND.manager, "root"));
    b.reverts("NoVotingPower", "human2", "@gov", "vote", [BigInt(later), true]);
    b.reverts("NotHumanSeat", "human2", "@gov", "veto", [BigInt(later)]);
  }),

  governed("handing a contract's governor on takes a high-tier proposal", (b) => {
    b.pass({ to: "@registry", fn: "setGovernor", args: ["root"] }, HIGH);
    // The root governs the tree by key again; the module no longer can.
    b.call("root", "@registry", "addNode", ["manager", KIND.manager, "root"]);
    const p = b.propose("root", LOW, hire("worker", KIND.worker, "manager"));
    b.vote("root", p);
    b.execute("root", p, { revert: "ActionFailed" });
    b.expect({ tree: ["root", "manager"] });
  }),

  governed(
    "an org deployed with no root seat: the root seats the first human, then steps back",
    (b) => {
      b.expect({
        governance: { humanSeatCount: 0n },
        seats: { root: { power: 0n, role: "none" } },
      });
      b.reverts("NotGovernance", "stranger", "@gov", "admitHuman", ["stranger", 1n]);
      b.call("root", "@gov", "admitHuman", ["human2", 2n], {
        events: ["VotingPowerUpdated", "HumanAdmitted"],
      });
      // A human is seated and it is not the root: the root's direct authority is over.
      b.reverts("NotGovernance", "root", "@gov", "admitHuman", ["root", 2n]);
      b.reverts("NotHumanRoot", "root", "@gov", "setQuorumYes", [1n]);
      b.reverts("NotHumanSeat", "root", "@gov", "veto", [1n]);

      const seatRoot = b.propose("human2", HIGH, {
        to: "@gov",
        fn: "admitHuman",
        args: ["root", 2n],
      });
      b.vote("human2", seatRoot);
      b.execute("human2", seatRoot, {
        events: ["VotingPowerUpdated", "HumanAdmitted", "ProposalExecuted"],
      });
      b.call("root", "@gov", "setQuorumYes", [2n]);
      b.expect({
        seats: { root: { power: 2n, role: "human" }, human2: { power: 2n, role: "human" } },
        governance: { humanSeatCount: 2n },
      });
    },
    { rootPower: 0n },
  ),
];
