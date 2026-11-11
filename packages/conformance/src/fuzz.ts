/**
 * A seeded generator of org activity.
 *
 * Each step is drawn from what the org currently looks like — the simulator's
 * state is the oracle for "which intents are pending, who awaits them" — so a
 * run reaches deep states (escalations climbing, proposals past their
 * timelock) instead of bouncing off the first guard. A share of every draw is
 * deliberately wrong: a stranger sending, a stale id, a bad argument.
 *
 * The generator only writes steps; whoever runs them decides what "correct"
 * means. Against two drivers, that is agreement.
 */

import type { kernel } from "@lacrew/sdk/sandbox";

import { ACTORS, type Actor, type GenesisOptions, type Ref } from "./refs.js";
import {
  DAY,
  HIGH,
  HOUR,
  KIND,
  LOW,
  MAX_UINT256,
  SEAT,
  ScenarioBuilder,
  USDC,
  type Arg,
  type CallSpec,
  type Step,
} from "./scenario.js";

/** mulberry32: small, fast, and the same sequence on every platform. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FuzzProfile = "direct" | "governed";

/** Genesis for a fuzz run: a tight rate limit, so its window fills and rolls over. */
export function fuzzGenesis(profile: FuzzProfile): GenesisOptions {
  return {
    bindGovernor: profile === "governed",
    rateLimit: { maxActions: 4n, windowSeconds: 600n },
  };
}

/** The fixed opening of a run: a crew with funds, built the way the profile allows. */
export function fuzzPrelude(profile: FuzzProfile): Step[] {
  const b = new ScenarioBuilder();
  if (profile === "direct") {
    b.crew();
    b.call("root", "@registry", "addNode", ["manager2", KIND.manager, "root"]);
    b.call("root", "@registry", "addNode", ["worker2", KIND.worker, "manager2"]);
    b.call("root", "@streamer", "setGrant", ["worker2", 100n * USDC]);
    b.call("root", "@gov", "setVotingPower", ["manager", 1n, SEAT.agent]);
    return b.steps;
  }
  b.pass({ to: "@registry", fn: "addNode", args: ["manager", KIND.manager, "root"] });
  b.pass({ to: "@registry", fn: "addNode", args: ["worker", KIND.worker, "manager"] });
  b.pass({ to: "@registry", fn: "addNode", args: ["worker2", KIND.worker, "root"] });
  b.pass({ to: "@whitelist", fn: "setAllowed", args: ["target", true] }, HIGH);
  b.pass({ to: "@spendCap", fn: "setAgentCap", args: ["manager", 200n * USDC] }, HIGH);
  b.pass(
    {
      to: "@streamer",
      fn: "setGrants",
      args: [
        ["worker", "worker2"],
        [200n * USDC, 100n * USDC],
      ],
    },
    HIGH,
  );
  b.fund(100_000n * USDC);
  b.call("root", "@streamer", "runNextEpoch");
  b.call("root", "@gov", "setVotingPower", ["manager", 1n, SEAT.agent]);
  return b.steps;
}

const NODES: Actor[] = ["manager", "manager2", "worker", "worker2", "human2"];
const AGENTS: Actor[] = ["worker", "worker", "worker2", "manager", "manager2", "human2", "root"];
const KEYS: Actor[] = ["key", "key2"];
const VALUES = [0n, 1n, 10n, 49n, 50n, 51n, 75n, 150n, 200n, 250n].map((v) => v * USDC);
const CAPS = [0n, 10n, 50n, 100n, 500n].map((v) => v * USDC);

const REF_OF = new Map<string, Ref>(
  Object.entries(ACTORS).map(([name, address]) => [address.toLowerCase(), name]),
);

/** Calldata an intent or a proposal may carry: some that the target accepts, some it refuses. */
const PAYLOADS: Arg[] = [
  "0x",
  "0x",
  "0x",
  "0x1234",
  { call: { to: "@registry", fn: "setActive", args: ["worker2", false] } },
  { call: { to: "@token", fn: "approve", args: ["target2", 1n] } },
  { call: { to: "@gov", fn: "propose", args: [LOW, "target", "0x1234"] } },
  { call: { to: "@gov", fn: "vote", args: [1n, true] } },
];

/** What a proposal may do, by the contract it is aimed at. */
const ACTIONS: CallSpec[] = [
  { to: "@registry", fn: "addNode", args: ["manager2", KIND.manager, "root"] },
  { to: "@registry", fn: "addNode", args: ["human2", KIND.human, "root"] },
  { to: "@registry", fn: "setActive", args: ["worker2", false] },
  { to: "@registry", fn: "setActive", args: ["worker2", true] },
  { to: "@registry", fn: "reparent", args: ["worker2", "manager"] },
  { to: "@registry", fn: "removeNode", args: ["manager2"] },
  { to: "@whitelist", fn: "setAllowed", args: ["target2", true] },
  { to: "@whitelist", fn: "setAllowed", args: ["target", false] },
  { to: "@whitelist", fn: "setAllowed", args: ["target", true] },
  { to: "@spendCap", fn: "setAgentCap", args: ["worker", 100n * USDC] },
  { to: "@spendCap", fn: "setAgentCap", args: ["manager", 20n * USDC] },
  { to: "@streamer", fn: "setGrant", args: ["worker", 50n * USDC] },
  { to: "@router", fn: "setNodePolicy", args: ["manager", "@managerStack"] },
  { to: "@router", fn: "setNodePolicy", args: ["worker", "@managerStack"] },
  { to: "@router", fn: "setNodePolicy", args: ["worker", "zero"] },
  { to: "@gov", fn: "admitHuman", args: ["human2", 2n] },
  { to: "@gov", fn: "removeHuman", args: ["human2"] },
  { to: "@gov", fn: "removeHuman", args: ["root"] },
  { to: "@gov", fn: "setVotingPower", args: ["worker", 2n, SEAT.agent] },
  { to: "@gov", fn: "setQuorumYes", args: [3n] },
  { to: "@gov", fn: "setQuorumHumanYes", args: [3n] },
  { to: "@gov", fn: "setTiming", args: [BigInt(HOUR), 600n] },
  { to: "@gov", fn: "setUnanimityFastPath", args: [false] },
  { to: "@registry", fn: "setGovernor", args: ["root"] },
];

export class Fuzzer {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = rng(seed);
  }

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  private chance(p: number): boolean {
    return this.next() < p;
  }

  private int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Mostly the rightful sender; sometimes someone who should be refused. */
  private sender(rightful: Ref, wrong: readonly Ref[] = ["stranger", "worker", "manager"]): Ref {
    return this.chance(0.88) ? rightful : this.pick(wrong);
  }

  private call(from: Ref, to: Ref, fn: string, args: Arg[]): Step {
    return { op: "call", from, call: { to, fn, args }, anyOutcome: true };
  }

  /** Draw the next step from the org as the simulator currently has it, at time `now`. */
  step(world: kernel.World, now: number): Step {
    const roll = this.next();
    if (roll < 0.3) return this.propose();
    if (roll < 0.45) return this.resolve(world);
    if (roll < 0.57) return this.session(world);
    if (roll < 0.67) return this.money();
    if (roll < 0.75) return this.admin();
    if (roll < 0.88) return this.governance(world);
    return this.warp(world, now);
  }

  /**
   * Move time. Half the jumps aim at a moment something changes — a session's
   * expiry, the end of a rate window, a proposal's deadline or timelock — so
   * that the next transaction lands a second before it, on it, or a second
   * after. Off-by-one is where a simulator and a contract part ways.
   */
  private warp(world: kernel.World, now: number): Step {
    const edges: bigint[] = [];
    for (const session of Object.values(world.sessionRegistry.sessions)) {
      edges.push(session.expiresAt);
    }
    for (const limit of Object.values(world.sessionRegistry.rateLimits)) {
      if (limit.windowStart > 0n) edges.push(limit.windowStart + limit.ratePeriod);
    }
    for (const module of Object.values(world.policies)) {
      if (module.kind !== "RateLimitPolicy") continue;
      for (const window of Object.values(module.windows)) {
        edges.push(window.windowStart + module.windowSeconds);
      }
    }
    for (const proposal of Object.values(world.governance.proposals)) {
      if (proposal.state === 0) edges.push(proposal.deadline, proposal.eta);
    }
    // The next transaction runs at now + seconds + 1.
    const ahead = edges
      .map((edge) => Number(edge) - now - 1 + this.int(-1, 1))
      .filter((seconds) => seconds > 0 && seconds < 60 * DAY);
    if (ahead.length > 0 && this.chance(0.5)) return { op: "warp", seconds: this.pick(ahead) };
    return { op: "warp", seconds: this.pick([1, 30, 300, 599, 600, HOUR, HOUR, DAY, 4 * DAY]) };
  }

  private propose(): Step {
    const agent = this.chance(0.95) ? this.pick(AGENTS) : "stranger";
    const who = this.next();
    const from = who < 0.5 ? agent : who < 0.88 ? this.pick(KEYS) : "stranger";
    const target = this.chance(0.75)
      ? this.pick(["target", "target", "target", "target2"])
      : this.pick(["@registry", "@token", "@gov", "@treasury", "@router", "zero", "stranger"]);
    return this.call(from, "@router", "propose", [
      agent,
      target,
      this.pick(VALUES),
      this.pick(PAYLOADS),
    ]);
  }

  private resolve(world: kernel.World): Step {
    const router = world.escalationRouter;
    const count = Number(router.nextIntentId) - 1;
    const pending = Object.entries(router.intents).filter(([, intent]) => !intent.resolved);
    // Usually an intent that is actually waiting, as the seat it waits on.
    if (pending.length > 0 && this.chance(0.85)) {
      const [id, intent] = this.pick(pending);
      const awaiting = REF_OF.get(intent.awaitingApprover) ?? "stranger";
      return this.call(
        this.sender(awaiting, ["stranger", "root", "manager"]),
        "@router",
        "resolve",
        [BigInt(id), this.chance(0.8)],
      );
    }
    return this.call(this.pick(["root", "manager", "stranger"]), "@router", "resolve", [
      BigInt(this.int(0, count + 1)),
      this.chance(0.8),
    ]);
  }

  private session(world: kernel.World): Step {
    const from = this.sender("root", ["stranger", "issuer"]);
    if (this.chance(0.2)) {
      const count = Number(world.sessionRegistry.nextSessionId) - 1;
      return this.call(from, "@sessions", "revoke", [BigInt(this.int(0, count + 1))]);
    }
    if (this.chance(0.08)) return this.call(from, "@sessions", "setIssuer", ["issuer"]);
    const agent = this.pick(AGENTS);
    const key = this.pick(KEYS);
    const expiry: Arg = { fromNow: this.pick([0, 60, HOUR, 2 * DAY, 2 * DAY, 40 * DAY]) };
    const mask = this.pick([1n, 2n, 3n, 3n, 3n, 0n, 4n]);
    const maxValue = this.pick([10n * USDC, 100n * USDC, MAX_UINT256, MAX_UINT256]);
    const targets = this.pick<Ref[]>([[], [], ["target"], ["target", "target2"], ["zero"]]);
    if (this.chance(0.3)) {
      return this.call(from, "@sessions", "issue", [
        agent,
        key,
        expiry,
        mask,
        maxValue,
        targets[0] ?? "zero",
      ]);
    }
    if (this.chance(0.2)) {
      return this.call(from, "@sessions", "issueScoped", [
        agent,
        key,
        expiry,
        mask,
        maxValue,
        targets,
      ]);
    }
    const window = this.pick<[number, number]>([
      [0, 0],
      [0, 0],
      [0, DAY],
      [80_000, 83_000],
      [10, 10],
    ]);
    const rate = this.pick<[number, number]>([
      [0, 0],
      [0, 0],
      [2, 600],
      [1, 60],
      [3, 0],
    ]);
    return this.call(from, "@sessions", "issueScopedTimed", [
      agent,
      key,
      expiry,
      mask,
      maxValue,
      targets,
      window[0],
      window[1],
      rate[0],
      rate[1],
    ]);
  }

  /** Funds: the token, the treasury, the streamer. */
  private money(): Step {
    const amount = this.pick([20n, 200n, 1_000n]) * USDC;
    switch (this.int(0, 6)) {
      case 0:
        return this.call(this.sender("root"), "@token", "mint", ["root", amount]);
      case 1:
        return this.call("root", "@token", "approve", ["@treasury", amount]);
      case 2:
        return this.call(this.sender("root"), "@treasury", "deposit", [amount]);
      case 3:
        return this.call(this.sender("root"), "@streamer", "setGrant", [
          this.pick(NODES),
          this.pick([0n, 20n * USDC, 200n * USDC]),
        ]);
      case 4:
        return this.call(this.sender("root"), "@streamer", "runEpoch", [BigInt(this.int(1, 12))]);
      default:
        return this.call(this.sender("root"), "@streamer", "runNextEpoch", []);
    }
  }

  /** Direct administration: lands in a `direct` org, is refused in a governed one. */
  private admin(): Step {
    const from = this.sender("root");
    switch (this.int(0, 6)) {
      case 0:
        return this.call(from, "@registry", "addNode", [
          this.pick([...NODES, "stranger"]),
          this.int(0, 2),
          this.pick([...NODES, "root"]),
        ]);
      case 1:
        return this.call(from, "@registry", "setActive", [this.pick(NODES), this.chance(0.5)]);
      case 2:
        return this.call(from, "@registry", "removeNode", [this.pick([...NODES, "root"])]);
      case 3:
        return this.call(from, "@registry", "reparent", [
          this.pick(NODES),
          this.pick([...NODES, "root"]),
        ]);
      case 4:
        return this.call(from, "@whitelist", "setAllowed", [
          this.pick(["target", "target2", "stranger", "@token", "@registry", "@gov", "@treasury"]),
          this.chance(0.7),
        ]);
      case 5:
        return this.call(from, "@spendCap", "setAgentCap", [this.pick(AGENTS), this.pick(CAPS)]);
      default:
        return this.call(from, "@router", "setNodePolicy", [
          this.pick(NODES),
          this.pick([
            "@policyStack",
            "@policyStack",
            "@managerStack",
            "@managerStack",
            "zero",
            "zero",
            "@spendCap",
            "@whitelist",
            "stranger",
          ]),
        ]);
    }
  }

  private governance(world: kernel.World): Step {
    const count = Number(world.governance.nextProposalId) - 1;
    const active = Object.entries(world.governance.proposals)
      .filter(([, p]) => p.state === 0)
      .map(([id]) => BigInt(id));
    const id =
      active.length > 0 && this.chance(0.85) ? this.pick(active) : BigInt(this.int(0, count + 1));
    const voter = this.pick<Ref>(["root", "root", "manager", "human2", "worker", "stranger"]);
    const roll = this.next();
    if (roll < 0.3 || count === 0) {
      const action = this.pick(ACTIONS);
      // High tier where the module demands it, and a share of wrong tiers.
      const needsHigh = action.to === "@gov" || action.fn === "setGovernor";
      const tier = this.chance(0.9) ? (needsHigh || this.chance(0.4) ? HIGH : LOW) : LOW;
      const target = this.chance(0.9) ? action.to : this.pick(["target", "zero"]);
      // Now and then, calldata no function answers: empty, or a bare selector.
      if (this.chance(0.08)) {
        return this.call(voter, "@gov", "propose", [tier, target, this.pick(["0x", "0xdeadbeef"])]);
      }
      return this.call(voter, "@gov", "propose", [tier, target, { call: action }]);
    }
    if (roll < 0.6) return this.call(voter, "@gov", "vote", [id, this.chance(0.8)]);
    if (roll < 0.9) return this.call(voter, "@gov", "execute", [id]);
    if (roll < 0.95) return this.call(voter, "@gov", "veto", [id]);
    return this.call(this.sender("root"), "@gov", "setVotingPower", [
      this.pick(["manager", "worker", "manager2"]),
      BigInt(this.int(0, 3)),
      SEAT.agent,
    ]);
  }
}

/** Properties of any reachable world, whatever sequence of calls produced it. */
export function worldInvariants(world: kernel.World): string[] {
  const broken: string[] = [];
  const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);

  const reserved = sum(Object.values(world.treasury.allowanceBalance));
  if (reserved !== world.treasury.totalReserved) {
    broken.push(`totalReserved ${world.treasury.totalReserved} != sum of allowances ${reserved}`);
  }
  const held = world.token.balances[world.addresses.treasury] ?? 0n;
  if (held < world.treasury.totalReserved) {
    broken.push(`treasury holds ${held}, less than it has reserved`);
  }
  const supply = sum(Object.values(world.token.balances));
  if (supply !== world.token.totalSupply) {
    broken.push(`token balances sum to ${supply}, supply is ${world.token.totalSupply}`);
  }

  const g = world.governance;
  const voters = Object.keys(g.votingPower) as Array<keyof typeof g.votingPower>;
  const total = sum(voters.map((v) => g.votingPower[v] ?? 0n));
  const humans = voters.filter((v) => g.seatRole[v] === 1);
  const humanTotal = sum(humans.map((v) => g.votingPower[v] ?? 0n));
  if (total !== g.totalVotingPower) broken.push("totalVotingPower drifted from the seats");
  if (humanTotal !== g.totalHumanVotingPower) broken.push("totalHumanVotingPower drifted");
  if (BigInt(humans.length) !== g.humanSeatCount) broken.push("humanSeatCount drifted");

  for (const [id, intent] of Object.entries(world.escalationRouter.intents)) {
    if (intent.awaitingApprover === "0x0000000000000000000000000000000000000000") {
      broken.push(`intent ${id} awaits nobody`);
    }
    if (intent.approved && !intent.resolved) broken.push(`intent ${id} approved but unresolved`);
  }
  const root = world.orgRegistry.nodes[world.orgRegistry.root];
  if (!root || !root.active) broken.push("the root node is gone or inactive");
  return broken;
}
