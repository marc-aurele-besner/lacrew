/**
 * The simulator under test: a sandbox client over a clock the driver moves.
 */

import {
  SimRevert,
  createSandboxClient,
  kernel,
  type SandboxLacrewClient,
  type SimEvent,
} from "@lacrew/sdk/sandbox";

import {
  GENESIS_TIME,
  START_TIME,
  type DeployOutcome,
  type Driver,
  type DriverEvent,
  type RawIntent,
  type TxOutcome,
} from "./driver.js";
import {
  ACTORS,
  type Address,
  type AddressBook,
  type ContractKind,
  type GenesisOptions,
  type Hex,
} from "./refs.js";

export class SimDriver implements Driver {
  readonly name = "sim";
  private time = GENESIS_TIME;
  private sandbox!: SandboxLacrewClient;
  private lastEvents: SimEvent[] = [];

  async reset(genesis: GenesisOptions): Promise<void> {
    this.time = GENESIS_TIME;
    this.sandbox = createSandboxClient({
      root: ACTORS.root,
      clock: { now: () => this.time },
      genesis,
      onCommit: (commit) => {
        this.lastEvents = commit.events;
      },
    });
    this.time = START_TIME;
  }

  get client(): SandboxLacrewClient {
    return this.sandbox;
  }

  /** The world behind the client, for callers that generate inputs from state. */
  get world(): kernel.World {
    return this.sandbox.world;
  }

  get book(): AddressBook {
    const a = this.sandbox.world.addresses;
    return {
      token: a.token,
      registry: a.orgRegistry,
      gov: a.governanceModule,
      treasury: a.treasury,
      router: a.escalationRouter,
      streamer: a.epochStreamer,
      sessions: a.sessionRegistry,
      whitelist: a.whitelistPolicy,
      spendCap: a.spendCapPolicy,
      rateLimit: a.rateLimitPolicy,
      timeWindow: a.timeWindowPolicy,
      policyStack: a.policyStack,
      managerStack: a.managerPolicyStack,
    };
  }

  now(): number {
    return this.time;
  }

  /** Run `fn` one second on; a revert puts the clock back. */
  private attempt<T>(
    fn: () => T,
  ): { ok: true; value: T; events: DriverEvent[] } | { ok: false; revert: string } {
    this.time += 1;
    this.lastEvents = [];
    try {
      const value = fn();
      const events = this.lastEvents
        .filter((event) => event.contract !== "External")
        .map((event) => ({ address: event.address, name: event.name, args: event.args }));
      return { ok: true, value, events };
    } catch (err) {
      this.time -= 1;
      if (err instanceof SimRevert) return { ok: false, revert: err.errorName };
      throw err;
    }
  }

  async send(from: Address, to: Address, data: Hex): Promise<TxOutcome> {
    const out = this.attempt(() => this.sandbox.sendTransaction({ from, to, data }));
    return out.ok ? { ok: true, events: out.events } : out;
  }

  async deploy(
    from: Address,
    contract: ContractKind,
    args: readonly unknown[],
  ): Promise<DeployOutcome> {
    const p = kernel.policies;
    const out = this.attempt(
      () =>
        this.sandbox.transact(from, (ctx) => {
          const address = kernel.allocateAddress(ctx);
          switch (contract) {
            case "PolicyStack":
              p.deployPolicyStack(ctx, address, args[0] as Address[]);
              break;
            case "SpendCapPolicy":
              p.deploySpendCapPolicy(ctx, address, args[0] as bigint);
              break;
            case "WhitelistPolicy":
              p.deployWhitelistPolicy(ctx, address);
              break;
            case "RateLimitPolicy":
              p.deployRateLimitPolicy(ctx, address, args[0] as bigint, args[1] as bigint);
              break;
            case "TimeWindowPolicy":
              p.deployTimeWindowPolicy(ctx, address, args[0] as bigint, args[1] as bigint);
              break;
            default:
              throw new Error(`the simulator deploys policy modules, not ${contract}`);
          }
          return address;
        }).result,
    );
    return out.ok ? { ok: true, address: out.value } : out;
  }

  async warp(seconds: number): Promise<void> {
    this.time += seconds;
  }

  async readIntent(id: bigint): Promise<RawIntent> {
    return this.sandbox.world.escalationRouter.intents[id.toString()]
      ? { ...this.sandbox.world.escalationRouter.intents[id.toString()]! }
      : {
          agent: kernel.ZERO_ADDRESS,
          target: kernel.ZERO_ADDRESS,
          value: 0n,
          data: "0x",
          awaitingApprover: kernel.ZERO_ADDRESS,
          resolved: false,
          approved: false,
        };
  }

  async balanceOf(account: Address): Promise<bigint> {
    return this.sandbox.world.token.balances[account.toLowerCase() as Address] ?? 0n;
  }

  async close(): Promise<void> {}
}
