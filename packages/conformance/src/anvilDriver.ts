/**
 * The real contracts under test: a local Anvil the driver spawns, with an org
 * deployed by the SDK's `deployOrg` from the bytecode shipped in @lacrew/core.
 *
 * Anvil signs for any sender (`--auto-impersonate`), so a scenario can act as
 * whoever it names. Each transaction is first run as an `eth_call` against the
 * pending block — which already carries the timestamp the transaction will be
 * mined at — so a revert is read with its error data and nothing is sent.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BaseError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  encodeDeployData,
  erc20Abi,
  http,
  type Abi,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { foundry } from "viem/chains";
import {
  policyStackBytecode,
  rateLimitPolicyBytecode,
  spendCapPolicyBytecode,
  timeWindowPolicyBytecode,
  whitelistPolicyBytecode,
} from "@lacrew/core";
import { createOnchainClient, deployOrg, type OnchainLacrewClient } from "@lacrew/sdk";

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
  ABIS,
  ACTORS,
  ROLES,
  type Address,
  type AddressBook,
  type ContractKind,
  type GenesisOptions,
  type Hex,
  type Role,
} from "./refs.js";

const BYTECODE: Partial<Record<ContractKind, Hex>> = {
  PolicyStack: policyStackBytecode,
  SpendCapPolicy: spendCapPolicyBytecode,
  WhitelistPolicy: whitelistPolicyBytecode,
  RateLimitPolicy: rateLimitPolicyBytecode,
  TimeWindowPolicy: timeWindowPolicyBytecode,
};

/** Every custom error any simulated contract can raise, for naming a revert by its data. */
const ALL_ERRORS = (() => {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const abi of Object.values(ABIS)) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const key = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out as Abi;
})();

const GAS = 12_000_000n;
const POLL_MS = 10;
const RICH = 10n ** 24n;

/** Where the `anvil` binary is, or null when Foundry is not installed. */
export function findAnvil(): string | null {
  const candidates = [
    process.env.ANVIL_BIN,
    "anvil",
    join(homedir(), ".foundry", "bin", "anvil"),
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** The revert's custom error name, from whatever viem wrapped it in. */
function revertName(err: unknown): string {
  if (!(err instanceof BaseError)) throw err;
  const carrier = err.walk((e) => (e as { data?: unknown }).data !== undefined) as {
    data?: unknown;
  } | null;
  const raw =
    typeof carrier?.data === "string"
      ? carrier.data
      : (carrier?.data as { data?: unknown } | undefined)?.data;
  if (typeof raw !== "string" || raw === "0x") {
    // A revert with no data: a call into an address with no such function.
    if (/revert/i.test(err.message)) return "EvmRevert";
    throw err;
  }
  const decoded = decodeErrorResult({ abi: ALL_ERRORS, data: raw as Hex });
  return decoded.errorName;
}

export class AnvilDriver implements Driver {
  readonly name = "anvil";
  private time = GENESIS_TIME;
  private blank!: Hex;
  private funded = new Set<string>();
  private onchain!: OnchainLacrewClient;
  private addresses!: AddressBook;
  /** Contract kind by lowercase address, for decoding logs. */
  private kinds = new Map<string, ContractKind>();

  private constructor(
    private readonly process: ChildProcess,
    private readonly url: string,
    private readonly publicClient: PublicClient,
    private readonly testClient: TestClient,
    private readonly wallet: WalletClient,
  ) {}

  static async start(binary: string): Promise<AnvilDriver> {
    const port = await freePort();
    const child = spawn(
      binary,
      [
        "--port",
        String(port),
        "--timestamp",
        String(GENESIS_TIME),
        "--auto-impersonate",
        "--silent",
      ],
      { stdio: "ignore" },
    );
    const url = `http://127.0.0.1:${port}`;
    const transport = http(url);
    // Anvil mines each transaction as it arrives: there is nothing to wait a polling interval for.
    const fast = { pollingInterval: POLL_MS, cacheTime: 0 };
    const publicClient = createPublicClient({ transport, chain: foundry, ...fast });
    const testClient = createTestClient({ transport, chain: foundry, mode: "anvil", ...fast });
    const wallet = createWalletClient({ transport, chain: foundry, ...fast });
    for (let attempt = 0; ; attempt++) {
      try {
        await publicClient.getChainId();
        break;
      } catch (err) {
        if (attempt > 100 || child.exitCode !== null) {
          child.kill();
          throw new Error(`anvil did not come up on ${url}: ${String(err)}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const driver = new AnvilDriver(child, url, publicClient as PublicClient, testClient, wallet);
    driver.blank = await testClient.snapshot();
    return driver;
  }

  async reset(genesis: GenesisOptions): Promise<void> {
    // Back to an empty chain; the snapshot is consumed by the revert, so retake it.
    await this.testClient.revert({ id: this.blank });
    this.blank = await this.testClient.snapshot();
    this.funded.clear();
    this.kinds.clear();
    // Earlier scenarios may have moved the node's clock far ahead.
    await this.testClient.setNextBlockTimestamp({ timestamp: BigInt(GENESIS_TIME + 1) });
    await this.fund(ACTORS.root);

    const deployed = await deployOrg({
      transport: http(this.url),
      chain: foundry,
      account: ACTORS.root,
      pollingInterval: POLL_MS,
      ...genesis,
    });
    const a = deployed.addresses;
    this.addresses = {
      token: a.mockUSDC!,
      registry: a.orgRegistry,
      gov: a.governanceModule,
      treasury: a.treasury,
      router: a.escalationRouter,
      streamer: a.epochStreamer!,
      sessions: a.sessionRegistry!,
      whitelist: a.whitelistPolicy!,
      spendCap: a.spendCapPolicy,
      rateLimit: deployed.rateLimitPolicy,
      timeWindow: a.timeWindowPolicy!,
      policyStack: a.policyStack!,
      managerStack: a.managerPolicyStack!,
    };
    for (const [role, address] of Object.entries(this.addresses)) {
      this.kinds.set(address.toLowerCase(), ROLES[role as Role]);
    }
    this.onchain = createOnchainClient({
      transport: http(this.url),
      chain: foundry,
      chainId: foundry.id,
      addresses: a,
    });

    this.time = START_TIME;
    await this.testClient.setNextBlockTimestamp({ timestamp: BigInt(START_TIME) });
    await this.testClient.mine({ blocks: 1 });
  }

  get client(): OnchainLacrewClient {
    return this.onchain;
  }

  get book(): AddressBook {
    return this.addresses;
  }

  now(): number {
    return this.time;
  }

  private async fund(account: Address): Promise<void> {
    const key = account.toLowerCase();
    if (this.funded.has(key)) return;
    await this.testClient.setBalance({ address: account, value: RICH });
    this.funded.add(key);
  }

  /**
   * Run a transaction one second on. The dry run against the pending block
   * decides: a revert is reported by name and nothing is mined; otherwise the
   * transaction is sent and its logs decoded.
   */
  private async attempt(
    from: Address,
    tx: { to?: Address; data: Hex },
  ): Promise<
    { ok: true; logs: DriverEvent[]; contractAddress?: Address } | { ok: false; revert: string }
  > {
    await this.fund(from);
    await this.testClient.setNextBlockTimestamp({ timestamp: BigInt(this.time + 1) });
    try {
      await this.publicClient.call({ account: from, ...tx, gas: GAS, blockTag: "pending" });
    } catch (err) {
      return { ok: false, revert: revertName(err) };
    }
    const hash = await this.wallet.sendTransaction({
      account: from,
      chain: foundry,
      gas: GAS,
      ...(tx.to ? { to: tx.to } : {}),
      data: tx.data,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`a transaction whose dry run succeeded reverted when mined: ${hash}`);
    }
    this.time += 1;
    const logs: DriverEvent[] = [];
    for (const log of receipt.logs) {
      const kind = this.kinds.get(log.address.toLowerCase());
      if (!kind) continue;
      const decoded = decodeEventLog({ abi: ABIS[kind], data: log.data, topics: log.topics });
      logs.push({
        address: log.address,
        name: String(decoded.eventName),
        args: (decoded.args ?? {}) as Record<string, unknown>,
      });
    }
    return {
      ok: true,
      logs,
      ...(receipt.contractAddress ? { contractAddress: receipt.contractAddress } : {}),
    };
  }

  async send(from: Address, to: Address, data: Hex): Promise<TxOutcome> {
    const out = await this.attempt(from, { to, data });
    return out.ok ? { ok: true, events: out.logs } : out;
  }

  async deploy(
    from: Address,
    contract: ContractKind,
    args: readonly unknown[],
  ): Promise<DeployOutcome> {
    const bytecode = BYTECODE[contract];
    if (!bytecode) throw new Error(`no bytecode to deploy a ${contract} from`);
    const data = encodeDeployData({ abi: ABIS[contract], bytecode, args: args as never });
    const out = await this.attempt(from, { data });
    if (!out.ok) return out;
    if (!out.contractAddress) throw new Error(`deploying ${contract} produced no address`);
    this.kinds.set(out.contractAddress.toLowerCase(), contract);
    return { ok: true, address: out.contractAddress };
  }

  async warp(seconds: number): Promise<void> {
    this.time += seconds;
    await this.testClient.setNextBlockTimestamp({ timestamp: BigInt(this.time) });
    await this.testClient.mine({ blocks: 1 });
  }

  async readIntent(id: bigint): Promise<RawIntent> {
    const [agent, target, value, data, awaitingApprover, resolved, approved] =
      (await this.publicClient.readContract({
        address: this.addresses.router,
        abi: ABIS.EscalationRouter,
        functionName: "intents",
        args: [id],
      })) as readonly [Address, Address, bigint, Hex, Address, boolean, boolean];
    return { agent, target, value, data, awaitingApprover, resolved, approved };
  }

  async balanceOf(account: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.addresses.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });
  }

  async close(): Promise<void> {
    this.process.kill();
  }
}
