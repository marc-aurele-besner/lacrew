/**
 * The whole simulated deployment as one value, and the two ways it changes:
 * `transact` (one atomic call) and `genesis` (the deployment itself, performed
 * as the same sequence of calls a real deploy makes).
 */

import * as epochStreamer from "./epochStreamer.js";
import * as escalationRouter from "./escalationRouter.js";
import * as governance from "./governance.js";
import * as orgRegistry from "./orgRegistry.js";
import * as policies from "./policies.js";
import * as sessionRegistry from "./sessionRegistry.js";
import * as token from "./token.js";
import * as treasury from "./treasury.js";
import {
  MAX_UINT256,
  ONE_DAY,
  SimRevert,
  ZERO_ADDRESS,
  addr,
  type Address,
  type CallContext,
  type Clock,
  type Hex,
  type KernelEnv,
  type SimEvent,
} from "./types.js";

/** Where each contract lives. Zero until that contract is deployed. */
export interface WorldAddresses {
  token: Address;
  orgRegistry: Address;
  governanceModule: Address;
  treasury: Address;
  escalationRouter: Address;
  epochStreamer: Address;
  sessionRegistry: Address;
  /** Modules of the reference stack, by role. */
  spendCapPolicy: Address;
  whitelistPolicy: Address;
  rateLimitPolicy: Address;
  timeWindowPolicy: Address;
  policyStack: Address;
  managerPolicyStack: Address;
}

export interface World {
  version: 1;
  /** Count of addresses handed out; the next deployment takes the next one. */
  nonce: bigint;
  addresses: WorldAddresses;
  token: token.TokenState;
  orgRegistry: orgRegistry.OrgRegistryState;
  governance: governance.GovernanceState;
  treasury: treasury.TreasuryState;
  escalationRouter: escalationRouter.EscalationRouterState;
  epochStreamer: epochStreamer.EpochStreamerState;
  sessionRegistry: sessionRegistry.SessionRegistryState;
  /** Policy modules by address. */
  policies: Record<Address, policies.PolicyModuleState>;
}

export type Ctx = CallContext<World>;

/** Nothing deployed: every contract reads as an address with no code would. */
export function blankWorld(): World {
  return {
    version: 1,
    nonce: 0n,
    addresses: {
      token: ZERO_ADDRESS,
      orgRegistry: ZERO_ADDRESS,
      governanceModule: ZERO_ADDRESS,
      treasury: ZERO_ADDRESS,
      escalationRouter: ZERO_ADDRESS,
      epochStreamer: ZERO_ADDRESS,
      sessionRegistry: ZERO_ADDRESS,
      spendCapPolicy: ZERO_ADDRESS,
      whitelistPolicy: ZERO_ADDRESS,
      rateLimitPolicy: ZERO_ADDRESS,
      timeWindowPolicy: ZERO_ADDRESS,
      policyStack: ZERO_ADDRESS,
      managerPolicyStack: ZERO_ADDRESS,
    },
    token: token.blankToken(),
    orgRegistry: orgRegistry.blankOrgRegistry(),
    governance: governance.blankGovernance(),
    treasury: treasury.blankTreasury(),
    escalationRouter: escalationRouter.blankEscalationRouter(),
    epochStreamer: epochStreamer.blankEpochStreamer(),
    sessionRegistry: sessionRegistry.blankSessionRegistry(),
    policies: {},
  };
}

/** Simulated contract addresses share a prefix no key pair is known for. */
const SIM_ADDRESS_PREFIX = "0x5a4d0000";

/** The address the `n`-th deployment lands at. */
export function simAddress(n: bigint): Address {
  return `${SIM_ADDRESS_PREFIX}${n.toString(16).padStart(32, "0")}` as Address;
}

/** Take the next deployment address. */
export function allocateAddress(ctx: Ctx): Address {
  ctx.world.nonce += 1n;
  return simAddress(ctx.world.nonce);
}

/**
 * An env for a world nothing calls out of: any `target.call` is treated as a
 * call to an address without code, and the action hash is a readable stand-in.
 * A client that decodes calldata supplies a real one.
 */
export const inertEnv: KernelEnv = {
  dispatch() {},
  actionHash(target: Address, data: Hex): Hex {
    return `0x${`${target.slice(2)}${data.slice(2)}`.padEnd(64, "0").slice(0, 64)}` as Hex;
  },
};

export interface TransactOptions {
  /** `msg.sender`. */
  sender: Address;
  /** `block.timestamp`: a clock to read, or the second itself. */
  at: Clock | bigint;
  env?: KernelEnv;
}

export interface TransactResult<T> {
  /** The state after the call. The world passed in is never modified. */
  world: World;
  result: T;
  events: SimEvent[];
}

/**
 * Run one call atomically: `fn` works on a copy, and the copy becomes the
 * world only if it returns. A `SimRevert` leaves the original as it was.
 */
export function transact<T>(
  world: World,
  options: TransactOptions,
  fn: (ctx: Ctx) => T,
): TransactResult<T> {
  const draft = structuredClone(world);
  const now = typeof options.at === "bigint" ? options.at : BigInt(options.at.now());
  const ctx: Ctx = {
    world: draft,
    sender: addr(options.sender),
    now,
    events: [],
    env: options.env ?? inertEnv,
  };
  const result = fn(ctx);
  return { world: draft, result, events: ctx.events };
}

/** Run a read against the world as it stands. Whatever `fn` writes is discarded. */
export function view<T>(world: World, options: TransactOptions, fn: (ctx: Ctx) => T): T {
  return transact(world, options, fn).result;
}

export interface GenesisParams {
  /** The org's human root: root node, root seat, session-registry root. */
  root: Address;
  /** Sends every deployment call; holds bootstrap authority until governors are bound. Defaults to `root`. */
  deployer?: Address;
  /** `EpochStreamer.operator`. Defaults to `root`. */
  operator?: Address;
  /** Voting weight seeded for the root. Defaults to 2. */
  rootPower?: bigint;
  /** `SpendCapPolicy.defaultCap`, in the spend token's base units. Defaults to 50e6. */
  defaultCap?: bigint;
  /** Default `RateLimitPolicy` parameters. Defaults to 10 actions per hour. */
  rateLimit?: { maxActions: bigint; windowSeconds: bigint };
  /** Default `TimeWindowPolicy` window. Defaults to the full UTC day. */
  timeWindow?: { startSecondOfDay: bigint; endSecondOfDay: bigint };
  /**
   * Hand every contract's authority to the GovernanceModule as the last step.
   * Defaults to true; false leaves the deployer in charge, for setups that
   * configure the org directly before binding governance.
   */
  bindGovernor?: boolean;
  /** `block.timestamp` of the deployment. */
  at: Clock | bigint;
  env?: KernelEnv;
}

/**
 * Deploy an empty org: one root node, no funds, no other seats.
 *
 * The contract set and the wiring follow `contracts/script/DeployMockOrg.s.sol`
 * with its fixtures left out — no manager, no worker, no minted treasury, no
 * whitelisted target. Each step is an ordinary kernel call from the deployer,
 * so authority at genesis is whatever those calls leave behind.
 */
export function genesis(params: GenesisParams): World {
  const root = addr(params.root);
  const deployer = addr(params.deployer ?? root);
  const operator = addr(params.operator ?? root);
  const rate = params.rateLimit ?? { maxActions: 10n, windowSeconds: 3_600n };
  const window = params.timeWindow ?? { startSecondOfDay: 0n, endSecondOfDay: ONE_DAY };

  let world = blankWorld();
  const run = (sender: Address, fn: (ctx: Ctx) => void): void => {
    world = transact(world, { sender, at: params.at, env: params.env }, fn).world;
  };
  const a = () => world.addresses;

  run(deployer, (ctx) => token.deploy(ctx, allocateAddress(ctx)));
  run(deployer, (ctx) => orgRegistry.deploy(ctx, allocateAddress(ctx), root));
  run(deployer, (ctx) =>
    governance.deploy(ctx, allocateAddress(ctx), root, params.rootPower ?? 2n),
  );

  run(deployer, (ctx) => {
    ctx.world.addresses.whitelistPolicy = allocateAddress(ctx);
    policies.deployWhitelistPolicy(ctx, ctx.world.addresses.whitelistPolicy);
  });
  run(deployer, (ctx) => {
    ctx.world.addresses.spendCapPolicy = allocateAddress(ctx);
    policies.deploySpendCapPolicy(
      ctx,
      ctx.world.addresses.spendCapPolicy,
      params.defaultCap ?? 50_000_000n,
    );
  });
  run(deployer, (ctx) => policies.setAgentCap(ctx, a().spendCapPolicy, root, MAX_UINT256));
  run(deployer, (ctx) => {
    ctx.world.addresses.rateLimitPolicy = allocateAddress(ctx);
    policies.deployRateLimitPolicy(
      ctx,
      ctx.world.addresses.rateLimitPolicy,
      rate.maxActions,
      rate.windowSeconds,
    );
  });
  run(deployer, (ctx) => {
    ctx.world.addresses.timeWindowPolicy = allocateAddress(ctx);
    policies.deployTimeWindowPolicy(
      ctx,
      ctx.world.addresses.timeWindowPolicy,
      window.startSecondOfDay,
      window.endSecondOfDay,
    );
  });
  run(deployer, (ctx) => {
    ctx.world.addresses.policyStack = allocateAddress(ctx);
    policies.deployPolicyStack(ctx, ctx.world.addresses.policyStack, [
      a().timeWindowPolicy,
      a().whitelistPolicy,
      a().spendCapPolicy,
      a().rateLimitPolicy,
    ]);
  });
  run(deployer, (ctx) => {
    ctx.world.addresses.managerPolicyStack = allocateAddress(ctx);
    policies.deployPolicyStack(ctx, ctx.world.addresses.managerPolicyStack, [
      a().whitelistPolicy,
      a().spendCapPolicy,
    ]);
  });

  run(deployer, (ctx) =>
    escalationRouter.deploy(ctx, allocateAddress(ctx), a().orgRegistry, a().policyStack),
  );
  run(deployer, (ctx) =>
    treasury.deploy(ctx, allocateAddress(ctx), a().orgRegistry, a().token, a().escalationRouter),
  );
  run(deployer, (ctx) => escalationRouter.setTreasury(ctx, a().treasury));
  run(deployer, (ctx) => escalationRouter.setRateRecorder(ctx, a().rateLimitPolicy));
  run(deployer, (ctx) => policies.setRecorder(ctx, a().rateLimitPolicy, a().escalationRouter));

  run(deployer, (ctx) => epochStreamer.deploy(ctx, allocateAddress(ctx), a().treasury, operator));
  run(deployer, (ctx) => treasury.setStreamer(ctx, a().epochStreamer));

  run(deployer, (ctx) => sessionRegistry.deploy(ctx, allocateAddress(ctx), root));
  run(deployer, (ctx) => escalationRouter.setSessionRegistry(ctx, a().sessionRegistry));
  run(root, (ctx) => sessionRegistry.setEscalationRouter(ctx, a().escalationRouter));

  if (params.bindGovernor ?? true) {
    world = bindGovernor(world, { root, deployer, operator, at: params.at, env: params.env });
  }
  return world;
}

/**
 * Hand every contract's constitutional authority to the GovernanceModule: the
 * registry (by its root), the treasury, router and policies (by the deployer),
 * and the streamer's grant schedule (by its operator).
 */
export function bindGovernor(
  world: World,
  params: {
    root: Address;
    deployer: Address;
    operator: Address;
    at: Clock | bigint;
    env?: KernelEnv;
  },
): World {
  let next = world;
  const gov = world.addresses.governanceModule;
  const run = (sender: Address, fn: (ctx: Ctx) => void): void => {
    next = transact(next, { sender, at: params.at, env: params.env }, fn).world;
  };
  run(params.root, (ctx) => orgRegistry.setGovernor(ctx, gov));
  run(params.deployer, (ctx) => treasury.setGovernor(ctx, gov));
  run(params.deployer, (ctx) => escalationRouter.setGovernor(ctx, gov));
  run(params.operator, (ctx) => epochStreamer.setGovernor(ctx, gov));
  run(params.deployer, (ctx) => policies.setGovernor(ctx, world.addresses.whitelistPolicy, gov));
  run(params.deployer, (ctx) => policies.setGovernor(ctx, world.addresses.spendCapPolicy, gov));
  return next;
}

export { SimRevert };
