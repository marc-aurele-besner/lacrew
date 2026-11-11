/**
 * GovernanceModule: quorum voting for constitutional actions.
 * Mirrors `contracts/src/GovernanceModule.sol`.
 */

import { emit, externalCall } from "./frame.js";
import {
  SimRevert,
  ZERO_ADDRESS,
  addr,
  byteLength,
  checkedAdd,
  checkedSub,
  type Address,
  type Hex,
} from "./types.js";
import type { Ctx } from "./world.js";

const CONTRACT = "GovernanceModule";

/** Enums by ABI value. */
export const Tier = { Low: 0, High: 1 } as const;
export const ProposalState = { Active: 0, Executed: 1, Vetoed: 2, Defeated: 3 } as const;
export const SeatRole = { None: 0, Human: 1, Agent: 2 } as const;

export const MIN_VOTING_PERIOD = 3_600n;
export const MAX_VOTING_PERIOD = 30n * 86_400n;
export const MAX_TIMELOCK = 30n * 86_400n;

/** `bytes4(keccak256("setGovernor(address)"))`. */
export const SET_GOVERNOR_SELECTOR = "0xc42cf535";

export interface ProposalRecord {
  proposer: Address;
  tier: number;
  target: Address;
  actionHash: Hex;
  data: Hex;
  yesVotes: bigint;
  noVotes: bigint;
  yesHumanVotes: bigint;
  deadline: bigint;
  eta: bigint;
  state: number;
}

export interface GovernanceState {
  humanRoot: Address;
  nextProposalId: bigint;
  /** Keyed by proposal id as a decimal string. */
  proposals: Record<string, ProposalRecord>;
  hasVoted: Record<string, Record<Address, boolean>>;
  votingPower: Record<Address, bigint>;
  seatRole: Record<Address, number>;
  totalVotingPower: bigint;
  totalHumanVotingPower: bigint;
  humanSeatCount: bigint;
  quorumYes: bigint;
  quorumHumanYes: bigint;
  votingPeriod: bigint;
  highTierTimelock: bigint;
  unanimityFastPath: boolean;
}

export function blankGovernance(): GovernanceState {
  return {
    humanRoot: ZERO_ADDRESS,
    nextProposalId: 1n,
    proposals: {},
    hasVoted: {},
    votingPower: {},
    seatRole: {},
    totalVotingPower: 0n,
    totalHumanVotingPower: 0n,
    humanSeatCount: 0n,
    quorumYes: 2n,
    quorumHumanYes: 1n,
    votingPeriod: 3n * 86_400n,
    highTierTimelock: 86_400n,
    unanimityFastPath: true,
  };
}

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

/** `proposals[id]`: an unset slot reads as the zero struct (Low tier, Active). */
function blankProposal(): ProposalRecord {
  return {
    proposer: ZERO_ADDRESS,
    tier: Tier.Low,
    target: ZERO_ADDRESS,
    actionHash: ZERO_HASH,
    data: "0x",
    yesVotes: 0n,
    noVotes: 0n,
    yesHumanVotes: 0n,
    deadline: 0n,
    eta: 0n,
    state: ProposalState.Active,
  };
}

/** A storage reference: the slot is materialised so a write through it lands. */
function proposalRef(state: GovernanceState, proposalId: bigint): ProposalRecord {
  return (state.proposals[proposalId.toString()] ??= blankProposal());
}

/** `proposals(id)`. */
export function proposals(ctx: Ctx, proposalId: bigint): ProposalRecord {
  return { ...(ctx.world.governance.proposals[proposalId.toString()] ?? blankProposal()) };
}

export function hasVoted(ctx: Ctx, proposalId: bigint, voter: Address): boolean {
  return ctx.world.governance.hasVoted[proposalId.toString()]?.[addr(voter)] ?? false;
}

function powerOf(state: GovernanceState, voter: Address): bigint {
  return state.votingPower[voter] ?? 0n;
}

function roleOf(state: GovernanceState, voter: Address): number {
  return state.seatRole[voter] ?? SeatRole.None;
}

/**
 * The root's direct authority holds while it has a funded Human seat, and
 * while no human is seated at all.
 */
function rootMayAct(ctx: Ctx): boolean {
  const state = ctx.world.governance;
  if (ctx.sender !== state.humanRoot) return false;
  return state.humanSeatCount === 0n || roleOf(state, state.humanRoot) === SeatRole.Human;
}

function isSelf(ctx: Ctx): boolean {
  return ctx.sender === ctx.world.addresses.governanceModule;
}

function onlyRootOrGovernance(ctx: Ctx): void {
  if (!isSelf(ctx) && !rootMayAct(ctx)) {
    throw new SimRevert("NotHumanRoot", { caller: ctx.sender });
  }
}

export function deploy(ctx: Ctx, address: Address, humanRoot_: Address, rootPower_: bigint): void {
  const humanRoot = addr(humanRoot_);
  if (humanRoot === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  ctx.world.addresses.governanceModule = address;
  const state = { ...blankGovernance(), humanRoot };
  ctx.world.governance = state;
  if (rootPower_ > 0n) {
    state.votingPower[humanRoot] = rootPower_;
    state.seatRole[humanRoot] = SeatRole.Human;
    state.totalVotingPower = rootPower_;
    state.totalHumanVotingPower = rootPower_;
    state.humanSeatCount = 1n;
    emit(ctx, address, CONTRACT, "VotingPowerUpdated", {
      voter: humanRoot,
      power: rootPower_,
      role: SeatRole.Human,
    });
  }
}

export function setVotingPower(ctx: Ctx, voter_: Address, power: bigint, role_: number): void {
  const state = ctx.world.governance;
  const voter = addr(voter_);
  let role = role_;
  if (voter === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  if (power === 0n) {
    role = SeatRole.None;
  } else if (role === SeatRole.None) {
    throw new SimRevert("InvalidSeatRole", { role });
  }
  if (role === SeatRole.Human || roleOf(state, voter) === SeatRole.Human) {
    authorizeSeatAdmin(ctx);
  } else if (!isSelf(ctx) && !rootMayAct(ctx)) {
    throw new SimRevert("NotHumanRoot", { caller: ctx.sender });
  }
  setSeat(ctx, voter, power, role);
}

export function admitHuman(ctx: Ctx, human_: Address, power: bigint): void {
  const human = addr(human_);
  if (human === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  if (power === 0n) throw new SimRevert("ZeroPower");
  authorizeSeatAdmin(ctx);
  setSeat(ctx, human, power, SeatRole.Human);
  emit(ctx, ctx.world.addresses.governanceModule, CONTRACT, "HumanAdmitted", { human, power });
}

export function removeHuman(ctx: Ctx, human_: Address): void {
  const human = addr(human_);
  if (roleOf(ctx.world.governance, human) !== SeatRole.Human) {
    throw new SimRevert("NotAHumanSeat", { account: human });
  }
  authorizeSeatAdmin(ctx);
  setSeat(ctx, human, 0n, SeatRole.None);
  emit(ctx, ctx.world.addresses.governanceModule, CONTRACT, "HumanRemoved", { human });
}

/** An executed proposal, or the root while the org has no human seat to consult. */
function authorizeSeatAdmin(ctx: Ctx): void {
  const state = ctx.world.governance;
  if (isSelf(ctx)) return;
  if (state.humanSeatCount === 0n && ctx.sender === state.humanRoot) return;
  throw new SimRevert("NotGovernance", { caller: ctx.sender });
}

/** Single writer for seat state, so the weight sums and the human head count cannot drift. */
function setSeat(ctx: Ctx, voter: Address, power: bigint, role: number): void {
  const state = ctx.world.governance;
  const prevPower = powerOf(state, voter);
  const prevRole = roleOf(state, voter);
  if (prevRole === SeatRole.Human && role !== SeatRole.Human) {
    if (state.humanSeatCount === 1n) throw new SimRevert("LastHumanSeat", { human: voter });
    state.humanSeatCount -= 1n;
  } else if (prevRole !== SeatRole.Human && role === SeatRole.Human) {
    state.humanSeatCount += 1n;
  }
  state.totalVotingPower = checkedAdd(checkedSub(state.totalVotingPower, prevPower), power);
  if (prevRole === SeatRole.Human) {
    state.totalHumanVotingPower = checkedSub(state.totalHumanVotingPower, prevPower);
  }
  if (role === SeatRole.Human) {
    state.totalHumanVotingPower = checkedAdd(state.totalHumanVotingPower, power);
  }
  state.votingPower[voter] = power;
  state.seatRole[voter] = role;
  emit(ctx, ctx.world.addresses.governanceModule, CONTRACT, "VotingPowerUpdated", {
    voter,
    power,
    role,
  });
}

export function setQuorumYes(ctx: Ctx, quorumYes_: bigint): void {
  onlyRootOrGovernance(ctx);
  if (quorumYes_ === 0n) throw new SimRevert("ZeroQuorum");
  ctx.world.governance.quorumYes = quorumYes_;
  emit(ctx, ctx.world.addresses.governanceModule, CONTRACT, "QuorumYesUpdated", {
    quorumYes: quorumYes_,
  });
}

export function setQuorumHumanYes(ctx: Ctx, quorumHumanYes_: bigint): void {
  onlyRootOrGovernance(ctx);
  if (quorumHumanYes_ === 0n) throw new SimRevert("ZeroQuorum");
  ctx.world.governance.quorumHumanYes = quorumHumanYes_;
  emit(ctx, ctx.world.addresses.governanceModule, CONTRACT, "QuorumHumanYesUpdated", {
    quorumHumanYes: quorumHumanYes_,
  });
}

export function setTiming(ctx: Ctx, votingPeriod_: bigint, highTierTimelock_: bigint): void {
  onlyRootOrGovernance(ctx);
  if (
    votingPeriod_ < MIN_VOTING_PERIOD ||
    votingPeriod_ > MAX_VOTING_PERIOD ||
    highTierTimelock_ > MAX_TIMELOCK
  ) {
    throw new SimRevert("InvalidTiming", {
      votingPeriod: votingPeriod_,
      highTierTimelock: highTierTimelock_,
    });
  }
  ctx.world.governance.votingPeriod = votingPeriod_;
  ctx.world.governance.highTierTimelock = highTierTimelock_;
  emit(ctx, ctx.world.addresses.governanceModule, CONTRACT, "TimingUpdated", {
    votingPeriod: votingPeriod_,
    highTierTimelock: highTierTimelock_,
  });
}

export function setUnanimityFastPath(ctx: Ctx, enabled: boolean): void {
  onlyRootOrGovernance(ctx);
  ctx.world.governance.unanimityFastPath = enabled;
  emit(ctx, ctx.world.addresses.governanceModule, CONTRACT, "UnanimityFastPathUpdated", {
    enabled,
  });
}

/** Low-tier quorum actually enforced: never more yes-weight than the seated electorate holds. */
export function effectiveQuorumYes(ctx: Ctx): bigint {
  const state = ctx.world.governance;
  const available = state.totalVotingPower;
  if (available > 0n && available < state.quorumYes) return available;
  return state.quorumYes;
}

/** High-tier human quorum actually enforced, capped at seated human weight. */
export function effectiveQuorumHumanYes(ctx: Ctx): bigint {
  const state = ctx.world.governance;
  const available = state.totalHumanVotingPower;
  if (available > 0n && available < state.quorumHumanYes) return available;
  return state.quorumHumanYes;
}

export function propose(ctx: Ctx, tier: number, target_: Address, data: Hex): bigint {
  const state = ctx.world.governance;
  const self = ctx.world.addresses.governanceModule;
  const target = addr(target_);
  if (target === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  if (target === self && tier !== Tier.High) throw new SimRevert("SelfTargetNotHighTier");
  if (
    tier !== Tier.High &&
    byteLength(data) >= 4 &&
    data.slice(0, 10).toLowerCase() === SET_GOVERNOR_SELECTOR
  ) {
    throw new SimRevert("GovernorTransferNotHighTier");
  }
  const proposalId = state.nextProposalId++;
  const actionHash = ctx.env.actionHash(target, data);
  const deadline = ctx.now + state.votingPeriod;
  state.proposals[proposalId.toString()] = {
    proposer: ctx.sender,
    tier,
    target,
    actionHash,
    data,
    yesVotes: 0n,
    noVotes: 0n,
    yesHumanVotes: 0n,
    deadline,
    eta: tier === Tier.High ? deadline + state.highTierTimelock : 0n,
    state: ProposalState.Active,
  };
  emit(ctx, self, CONTRACT, "ProposalCreated", {
    proposalId,
    proposer: ctx.sender,
    tier,
    target,
    actionHash,
  });
  return proposalId;
}

export function vote(ctx: Ctx, proposalId: bigint, support: boolean): void {
  const state = ctx.world.governance;
  const p = proposalRef(state, proposalId);
  if (p.state !== ProposalState.Active || ctx.now > p.deadline) {
    throw new SimRevert("ProposalNotActive", { proposalId });
  }
  if (hasVoted(ctx, proposalId, ctx.sender)) {
    throw new SimRevert("AlreadyVoted", { proposalId, voter: ctx.sender });
  }

  const weight = powerOf(state, ctx.sender);
  if (weight === 0n) throw new SimRevert("NoVotingPower", { voter: ctx.sender });

  (state.hasVoted[proposalId.toString()] ??= {})[ctx.sender] = true;
  if (support) {
    p.yesVotes = checkedAdd(p.yesVotes, weight);
    if (roleOf(state, ctx.sender) === SeatRole.Human) {
      p.yesHumanVotes = checkedAdd(p.yesHumanVotes, weight);
    }
  } else {
    p.noVotes = checkedAdd(p.noVotes, weight);
  }
  emit(ctx, ctx.world.addresses.governanceModule, CONTRACT, "Voted", {
    proposalId,
    voter: ctx.sender,
    support,
    weight,
  });
}

export function veto(ctx: Ctx, proposalId: bigint): void {
  const state = ctx.world.governance;
  const humanSeat = powerOf(state, ctx.sender) > 0n && roleOf(state, ctx.sender) === SeatRole.Human;
  if (!humanSeat && !rootMayAct(ctx)) throw new SimRevert("NotHumanSeat", { caller: ctx.sender });
  const p = proposalRef(state, proposalId);
  if (p.state !== ProposalState.Active) throw new SimRevert("ProposalNotActive", { proposalId });
  p.state = ProposalState.Vetoed;
  emit(ctx, ctx.world.addresses.governanceModule, CONTRACT, "ProposalVetoed", {
    proposalId,
    vetoer: ctx.sender,
  });
}

export function execute(ctx: Ctx, proposalId: bigint): void {
  const state = ctx.world.governance;
  const self = ctx.world.addresses.governanceModule;
  const p = proposalRef(state, proposalId);
  if (p.state !== ProposalState.Active) throw new SimRevert("ProposalNotActive", { proposalId });

  if (p.tier === Tier.High) {
    if (p.yesHumanVotes < effectiveQuorumHumanYes(ctx)) {
      throw new SimRevert("QuorumNotMet", { proposalId });
    }
    if (ctx.now < p.eta && !unanimousHumanYes(state, p)) {
      throw new SimRevert("TimelockNotElapsed", { proposalId, eta: p.eta });
    }
  } else if (p.yesVotes < effectiveQuorumYes(ctx)) {
    throw new SimRevert("QuorumNotMet", { proposalId });
  }

  if (ctx.now > p.deadline && p.noVotes > p.yesVotes) {
    p.state = ProposalState.Defeated;
    emit(ctx, self, CONTRACT, "ProposalDefeated", { proposalId });
    return;
  }

  p.state = ProposalState.Executed;
  const { target, data } = p;
  const ok = externalCall(ctx, self, target, data);
  if (!ok) throw new SimRevert("ActionFailed", { target });
  emit(ctx, self, CONTRACT, "ProposalExecuted", { proposalId });
}

/** The timelock shields humans who have not voted; unanimity means none remain. */
function unanimousHumanYes(state: GovernanceState, p: ProposalRecord): boolean {
  return (
    state.unanimityFastPath &&
    state.totalHumanVotingPower > 0n &&
    p.yesHumanVotes >= state.totalHumanVotingPower
  );
}
