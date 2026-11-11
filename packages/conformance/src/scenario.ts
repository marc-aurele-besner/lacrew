/**
 * What a scenario is: a list of typed steps, each with the outcome the
 * contracts must produce. A scenario says nothing about how it is executed, so
 * the same list runs against the simulator and against a chain.
 */

import type { ContractKind, GenesisOptions, Ref } from "./refs.js";

/**
 * A call argument. Strings are refs unless they are hex; `{ call }` is the
 * calldata of another call (a governance action, an intent's payload);
 * `{ fromNow }` is a timestamp that many seconds after the step runs.
 */
export type Arg =
  bigint | number | boolean | string | Arg[] | { call: CallSpec } | { fromNow: number };

export interface CallSpec {
  /** The contract called: a role (`@router`) or a deployed label (`$stack`). */
  to: Ref;
  fn: string;
  args?: Arg[];
}

export type Verdict = "ALLOW" | "ESCALATE";

/** The step must succeed; optionally with this router verdict or exactly these events. */
export interface ExpectOk {
  verdict?: Verdict;
  /** Event names the transaction emits, in order. */
  events?: string[];
}

/** The step must revert with this custom error. */
export interface ExpectRevert {
  revert: string;
  /**
   * The contract that raises the error, when it is not the one called (a
   * router propose that fails inside the Treasury). Checked against that
   * contract's ABI, so a misattributed error fails the suite.
   */
  in?: ContractKind;
}

export type Expect = ExpectOk | ExpectRevert;

export const isRevert = (expect: Expect | undefined): expect is ExpectRevert =>
  expect !== undefined && "revert" in expect;

/** What must be true of the org after the steps so far. Every field is optional. */
export interface StateExpectation {
  /** Treasury allowance per node, base units. */
  allowance?: Record<Ref, bigint>;
  treasury?: { total?: bigint; liquid?: bigint; reserved?: bigint };
  /** Spend-token balance per account. */
  balance?: Record<Ref, bigint>;
  /** Intents by id. `awaiting: null` means nobody. */
  intents?: Record<
    number,
    { awaiting?: Ref | null; resolved?: boolean; approved?: boolean; value?: bigint }
  >;
  /** Ids of the intents still pending, in order. */
  pending?: number[];
  /** Session keys of an agent, by key: whether the chain honours it right now. */
  keys?: Array<{ agent: Ref; key: Ref; valid: boolean; maxValue?: bigint }>;
  /** Org nodes; `null` means the account is not in the tree. */
  nodes?: Record<Ref, { parent?: Ref | null; active?: boolean; kind?: string } | null>;
  /** The whole tree, in read order, as account refs. */
  tree?: Ref[];
  /** True when the tree cannot be read at all. */
  treeUnreadable?: boolean;
  epoch?: number;
  grants?: Record<Ref, bigint>;
  proposals?: Record<number, { state?: string; yesVotes?: number; noVotes?: number }>;
  seats?: Record<Ref, { power: bigint; role: string }>;
  caps?: Record<Ref, bigint>;
  /** Verdicts a policy module gives without anything being proposed. */
  verdicts?: Array<{
    agent: Ref;
    target: Ref;
    value: bigint;
    verdict: string;
    module?: Ref;
  }>;
  governance?: { humanSeatCount?: bigint; quorumYes?: bigint; unanimityFastPath?: boolean };
  /**
   * Seconds into the UTC day the clock stands at. Pins the step count a
   * scenario's exact-boundary arithmetic rests on.
   */
  secondOfDay?: number;
}

export type Step =
  | {
      op: "call";
      from: Ref;
      call: CallSpec;
      expect?: Expect;
      /**
       * Accept whatever happens and only record it. For generated steps, whose
       * outcome is not known in advance and is checked by comparing drivers.
       */
      anyOutcome?: boolean;
      /**
       * Errors this step exercises that never surface as its own revert name:
       * ones raised inside a low-level call the contract swallows.
       */
      covers?: string[];
      note?: string;
    }
  | {
      op: "deploy";
      from: Ref;
      contract: ContractKind;
      args?: Arg[];
      /** Label the new module goes by (`$label`). */
      as: string;
      expect?: ExpectRevert;
    }
  | { op: "warp"; seconds: number }
  | { op: "assert"; state: StateExpectation; note?: string };

export interface Scenario {
  name: string;
  genesis?: GenesisOptions;
  steps: Step[];
}

export const USDC = 1_000_000n;
export const HOUR = 3_600;
export const DAY = 86_400;
export const MAX_UINT256 = 2n ** 256n - 1n;

/** Session scope bits. */
export const PROPOSE = 1n;
export const SPEND = 2n;
export const BOTH = 3n;

/** `GovernanceModule.Tier` and `SeatRole`, `IOrgRegistry.NodeKind`, by ABI value. */
export const LOW = 0;
export const HIGH = 1;
export const SEAT = { none: 0, human: 1, agent: 2 } as const;
export const KIND = { human: 0, manager: 1, worker: 2 } as const;

export interface SessionOptions {
  agent?: Ref;
  key?: Ref;
  /** Seconds until expiry. */
  ttl?: number;
  mask?: bigint;
  maxValue?: bigint;
  targets?: Ref[];
  window?: [number, number];
  rate?: [number, number];
  from?: Ref;
}

/**
 * Writes steps without bookkeeping: it counts intent, session and proposal
 * ids as the contracts will, so a scenario can refer to "the intent this
 * propose created".
 */
export class ScenarioBuilder {
  readonly steps: Step[] = [];
  private intentId = 0;
  private sessionId = 0;
  private proposalId = 0;

  call(from: Ref, to: Ref, fn: string, args: Arg[] = [], expect?: Expect, covers?: string[]): this {
    this.steps.push({
      op: "call",
      from,
      call: { to, fn, args },
      ...(expect ? { expect } : {}),
      ...(covers ? { covers } : {}),
    });
    return this;
  }

  /** A call that must revert with `revert`, raised by `inContract` when not by the callee. */
  reverts(
    revert: string,
    from: Ref,
    to: Ref,
    fn: string,
    args: Arg[] = [],
    inContract?: ContractKind,
  ): this {
    return this.call(from, to, fn, args, { revert, ...(inContract ? { in: inContract } : {}) });
  }

  deploy(from: Ref, contract: ContractKind, as: string, args: Arg[] = [], revert?: string): this {
    this.steps.push({
      op: "deploy",
      from,
      contract,
      args,
      as,
      ...(revert ? { expect: { revert } } : {}),
    });
    return this;
  }

  warp(seconds: number): this {
    this.steps.push({ op: "warp", seconds });
    return this;
  }

  expect(state: StateExpectation, note?: string): this {
    this.steps.push({ op: "assert", state, ...(note ? { note } : {}) });
    return this;
  }

  // ——— EscalationRouter ———

  /** `propose` expected to settle at once. */
  allow(from: Ref, agent: Ref, target: Ref, value: bigint, data: Arg = "0x"): this {
    return this.call(from, "@router", "propose", [agent, target, value, data], {
      verdict: "ALLOW",
    });
  }

  /** `propose` expected to create an intent; returns its id. */
  escalate(from: Ref, agent: Ref, target: Ref, value: bigint, data: Arg = "0x"): number {
    this.call(from, "@router", "propose", [agent, target, value, data], { verdict: "ESCALATE" });
    return ++this.intentId;
  }

  /** `propose` expected to revert. */
  proposeReverts(
    revert: string,
    from: Ref,
    agent: Ref,
    target: Ref,
    value: bigint,
    inContract?: ContractKind,
    data: Arg = "0x",
  ): this {
    return this.reverts(
      revert,
      from,
      "@router",
      "propose",
      [agent, target, value, data],
      inContract,
    );
  }

  resolve(from: Ref, intentId: number, approved: boolean, expect?: Expect): this {
    return this.call(from, "@router", "resolve", [BigInt(intentId), approved], expect);
  }

  // ——— SessionRegistry ———

  private sessionArgs(o: SessionOptions): Arg[] {
    return [
      o.agent ?? "worker",
      o.key ?? "key",
      { fromNow: o.ttl ?? DAY },
      o.mask ?? BOTH,
      o.maxValue ?? MAX_UINT256,
    ];
  }

  /** Issue a session through whichever entry point fits its options; returns the session id. */
  session(o: SessionOptions = {}): number {
    const from = o.from ?? "root";
    const base = this.sessionArgs(o);
    if (o.window || o.rate) {
      this.call(from, "@sessions", "issueScopedTimed", [
        ...base,
        o.targets ?? [],
        o.window?.[0] ?? 0,
        o.window?.[1] ?? 0,
        o.rate?.[0] ?? 0,
        o.rate?.[1] ?? 0,
      ]);
    } else if ((o.targets?.length ?? 0) > 1) {
      this.call(from, "@sessions", "issueScoped", [...base, o.targets!]);
    } else {
      this.call(from, "@sessions", "issue", [...base, o.targets?.[0] ?? "zero"]);
    }
    return ++this.sessionId;
  }

  /** `issueScopedTimed` expected to revert. */
  sessionReverts(revert: string, o: SessionOptions = {}): this {
    return this.reverts(revert, o.from ?? "root", "@sessions", "issueScopedTimed", [
      ...this.sessionArgs(o),
      o.targets ?? [],
      o.window?.[0] ?? 0,
      o.window?.[1] ?? 0,
      o.rate?.[0] ?? 0,
      o.rate?.[1] ?? 0,
    ]);
  }

  // ——— GovernanceModule ———

  /** Create a proposal; returns its id. */
  propose(from: Ref, tier: number, action: CallSpec | { to: Ref; data: string }): number {
    const data: Arg = "fn" in action ? { call: action } : action.data;
    this.call(from, "@gov", "propose", [tier, action.to, data]);
    return ++this.proposalId;
  }

  vote(from: Ref, proposalId: number, support = true, expect?: Expect): this {
    return this.call(from, "@gov", "vote", [BigInt(proposalId), support], expect);
  }

  execute(from: Ref, proposalId: number, expect?: Expect, covers?: string[]): this {
    return this.call(from, "@gov", "execute", [BigInt(proposalId)], expect, covers);
  }

  veto(from: Ref, proposalId: number, expect?: Expect): this {
    return this.call(from, "@gov", "veto", [BigInt(proposalId)], expect);
  }

  /** Propose, collect yes votes and execute; returns the proposal id. */
  pass(action: CallSpec, tier: number = LOW, voters: Ref[] = ["root"]): number {
    const id = this.propose("root", tier, action);
    for (const voter of voters) this.vote(voter, id);
    this.execute("root", id);
    return id;
  }

  // ——— common setups ———

  /** Mint to the root and deposit into the treasury. */
  fund(amount: bigint): this {
    return this.call("root", "@token", "mint", ["root", amount])
      .call("root", "@token", "approve", ["@treasury", amount])
      .call("root", "@treasury", "deposit", [amount]);
  }

  /**
   * The reference crew on an org whose deployer still has direct authority
   * (`bindGovernor: false`): manager under root, worker under manager, one
   * whitelisted target, a funded treasury, and 200 streamed to the worker.
   */
  crew(): this {
    this.call("root", "@registry", "addNode", ["manager", KIND.manager, "root"])
      .call("root", "@registry", "addNode", ["worker", KIND.worker, "manager"])
      .call("root", "@router", "setNodePolicy", ["manager", "@managerStack"])
      .call("root", "@whitelist", "setAllowed", ["target", true])
      .call("root", "@spendCap", "setAgentCap", ["manager", 200n * USDC])
      .fund(100_000n * USDC)
      .call("root", "@streamer", "setGrant", ["worker", 200n * USDC])
      .call("root", "@streamer", "runNextEpoch");
    return this;
  }
}

/** Define a scenario on an org whose deployer keeps direct authority. */
export function scenario(
  name: string,
  build: (b: ScenarioBuilder) => void,
  genesis: GenesisOptions = {},
): Scenario {
  const b = new ScenarioBuilder();
  build(b);
  return { name, genesis: { bindGovernor: false, ...genesis }, steps: b.steps };
}

/** Define a scenario on an org governed the way a deployed one is: by proposal. */
export function governed(
  name: string,
  build: (b: ScenarioBuilder) => void,
  genesis: GenesisOptions = {},
): Scenario {
  const b = new ScenarioBuilder();
  build(b);
  return { name, genesis: { bindGovernor: true, ...genesis }, steps: b.steps };
}
