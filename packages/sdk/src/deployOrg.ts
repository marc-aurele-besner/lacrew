/**
 * Deploy a whole, empty org to a chain from the bytecode carried in
 * @lacrew/core: no Foundry, no script, one function.
 *
 * The contract set and the wiring follow `contracts/script/DeployMockOrg.s.sol`
 * with its fixtures left out — no manager, no worker, no minted treasury, no
 * whitelisted target. The result is one root node and a treasury holding
 * nothing, with every contract's authority handed to the GovernanceModule.
 *
 * One key signs every step, so the deployer is the org's human root and the
 * EpochStreamer's operator: the registry, the session registry and the
 * streamer each take a bootstrap call only from that seat.
 */

import {
  createPublicClient,
  createWalletClient,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import {
  epochStreamerAbi,
  epochStreamerBytecode,
  escalationRouterAbi,
  escalationRouterBytecode,
  governanceModuleAbi,
  governanceModuleBytecode,
  marketplacePaymentsAbi,
  marketplacePaymentsBytecode,
  mockUsdcAbi,
  mockUsdcBytecode,
  orgRegistryAbi,
  orgRegistryBytecode,
  policyStackAbi,
  policyStackBytecode,
  rateLimitPolicyAbi,
  rateLimitPolicyBytecode,
  sessionRegistryAbi,
  sessionRegistryBytecode,
  spendCapPolicyAbi,
  spendCapPolicyBytecode,
  timeWindowPolicyAbi,
  timeWindowPolicyBytecode,
  treasuryAbi,
  treasuryBytecode,
  whitelistPolicyAbi,
  whitelistPolicyBytecode,
  type ChainAddresses,
} from "@lacrew/core";

type Address = `0x${string}`;

const MAX_UINT256 = 2n ** 256n - 1n;

export type DeployOrgOptions = {
  transport: Transport;
  chain?: Chain;
  /**
   * Signs and pays for every deployment transaction, and becomes the org's
   * human root. A local account, or the address of an account the node signs
   * for.
   */
  account: Account | Address;
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
   * Defaults to true; false leaves the deployer in charge.
   */
  bindGovernor?: boolean;
  /**
   * Also deploy MarketplacePayments over the spend token, with the router as
   * its settlement router. `feeBps` defaults to 2000 and `feeRecipient` to the
   * root. Off by default: an org does not need a marketplace to run.
   */
  marketplace?: { feeBps?: number; feeRecipient?: Address };
  /** Gas limit for each transaction; omit to let the node estimate. */
  gas?: bigint;
  /** How often to poll for each receipt, in ms. Lower it on a local node that mines at once. */
  pollingInterval?: number;
};

export type DeployedOrg = {
  addresses: ChainAddresses;
  /** The default rate-limit module, which `ChainAddresses` has no slot for. */
  rateLimitPolicy: Address;
  /** Every transaction sent, in order. */
  txHashes: Hex[];
};

export async function deployOrg(options: DeployOrgOptions): Promise<DeployedOrg> {
  const polling =
    options.pollingInterval === undefined ? {} : { pollingInterval: options.pollingInterval };
  const publicClient = createPublicClient({
    transport: options.transport,
    chain: options.chain,
    ...polling,
  });
  const wallet = createWalletClient({
    account: options.account,
    transport: options.transport,
    chain: options.chain,
    ...polling,
  });
  const account = wallet.account;
  const root = account.address;
  const chain = options.chain ?? null;
  const txHashes: Hex[] = [];

  const confirm = async (hash: Hex, what: string) => {
    txHashes.push(hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${what} reverted onchain: ${hash}`);
    return receipt;
  };

  const deploy = async (
    what: string,
    abi: Abi | readonly unknown[],
    bytecode: Hex,
    args: readonly unknown[] = [],
  ): Promise<Address> => {
    const hash = await wallet.deployContract({
      abi: abi as Abi,
      bytecode,
      args: args as never,
      account,
      chain,
      ...(options.gas ? { gas: options.gas } : {}),
    });
    const receipt = await confirm(hash, `deploy ${what}`);
    if (!receipt.contractAddress) throw new Error(`deploy ${what} returned no contract address`);
    return receipt.contractAddress;
  };

  const send = async (
    address: Address,
    abi: Abi | readonly unknown[],
    functionName: string,
    args: readonly unknown[],
  ): Promise<void> => {
    const hash = await wallet.writeContract({
      address,
      abi: abi as Abi,
      functionName,
      args: args as never,
      account,
      chain,
      ...(options.gas ? { gas: options.gas } : {}),
    });
    await confirm(hash, functionName);
  };

  const rate = options.rateLimit ?? { maxActions: 10n, windowSeconds: 3_600n };
  const window = options.timeWindow ?? { startSecondOfDay: 0n, endSecondOfDay: 86_400n };

  const mockUSDC = await deploy("MockUSDC", mockUsdcAbi, mockUsdcBytecode);
  const orgRegistry = await deploy("OrgRegistry", orgRegistryAbi, orgRegistryBytecode, [root]);
  const governanceModule = await deploy(
    "GovernanceModule",
    governanceModuleAbi,
    governanceModuleBytecode,
    [root, options.rootPower ?? 2n],
  );

  const whitelistPolicy = await deploy(
    "WhitelistPolicy",
    whitelistPolicyAbi,
    whitelistPolicyBytecode,
  );
  const spendCapPolicy = await deploy("SpendCapPolicy", spendCapPolicyAbi, spendCapPolicyBytecode, [
    options.defaultCap ?? 50_000_000n,
  ]);
  // The root is never the one a spend cap is meant to stop.
  await send(spendCapPolicy, spendCapPolicyAbi, "setAgentCap", [root, MAX_UINT256]);
  const rateLimitPolicy = await deploy(
    "RateLimitPolicy",
    rateLimitPolicyAbi,
    rateLimitPolicyBytecode,
    [rate.maxActions, rate.windowSeconds],
  );
  const timeWindowPolicy = await deploy(
    "TimeWindowPolicy",
    timeWindowPolicyAbi,
    timeWindowPolicyBytecode,
    [window.startSecondOfDay, window.endSecondOfDay],
  );
  const policyStack = await deploy("PolicyStack", policyStackAbi, policyStackBytecode, [
    [timeWindowPolicy, whitelistPolicy, spendCapPolicy, rateLimitPolicy],
  ]);
  const managerPolicyStack = await deploy("PolicyStack", policyStackAbi, policyStackBytecode, [
    [whitelistPolicy, spendCapPolicy],
  ]);

  const escalationRouter = await deploy(
    "EscalationRouter",
    escalationRouterAbi,
    escalationRouterBytecode,
    [orgRegistry, policyStack],
  );
  const treasury = await deploy("Treasury", treasuryAbi, treasuryBytecode, [
    orgRegistry,
    mockUSDC,
    escalationRouter,
  ]);
  await send(escalationRouter, escalationRouterAbi, "setTreasury", [treasury]);
  await send(escalationRouter, escalationRouterAbi, "setRateRecorder", [rateLimitPolicy]);
  await send(rateLimitPolicy, rateLimitPolicyAbi, "setRecorder", [escalationRouter]);

  const epochStreamer = await deploy("EpochStreamer", epochStreamerAbi, epochStreamerBytecode, [
    treasury,
    root,
  ]);
  await send(treasury, treasuryAbi, "setStreamer", [epochStreamer]);

  const sessionRegistry = await deploy(
    "SessionRegistry",
    sessionRegistryAbi,
    sessionRegistryBytecode,
    [root],
  );
  await send(escalationRouter, escalationRouterAbi, "setSessionRegistry", [sessionRegistry]);
  await send(sessionRegistry, sessionRegistryAbi, "setEscalationRouter", [escalationRouter]);

  let marketplacePayments: Address | undefined;
  if (options.marketplace) {
    // Not wired into Treasury or the router's authority: a purchase is a
    // policy-checked spend to this contract, which the root still whitelists.
    marketplacePayments = await deploy(
      "MarketplacePayments",
      marketplacePaymentsAbi,
      marketplacePaymentsBytecode,
      [
        mockUSDC,
        options.marketplace.feeRecipient ?? root,
        root,
        options.marketplace.feeBps ?? 2000,
      ],
    );
    await send(marketplacePayments, marketplacePaymentsAbi, "setSettlementRouter", [
      escalationRouter,
    ]);
  }

  if (options.bindGovernor ?? true) {
    await send(orgRegistry, orgRegistryAbi, "setGovernor", [governanceModule]);
    await send(treasury, treasuryAbi, "setGovernor", [governanceModule]);
    await send(escalationRouter, escalationRouterAbi, "setGovernor", [governanceModule]);
    await send(epochStreamer, epochStreamerAbi, "setGovernor", [governanceModule]);
    await send(whitelistPolicy, whitelistPolicyAbi, "setGovernor", [governanceModule]);
    await send(spendCapPolicy, spendCapPolicyAbi, "setGovernor", [governanceModule]);
  }

  const chainId = options.chain?.id ?? (await publicClient.getChainId());
  return {
    addresses: {
      chainId,
      orgRegistry,
      treasury,
      escalationRouter,
      governanceModule,
      spendCapPolicy,
      mockUSDC,
      policyStack,
      managerPolicyStack,
      whitelistPolicy,
      timeWindowPolicy,
      epochStreamer,
      sessionRegistry,
      ...(marketplacePayments ? { marketplacePayments } : {}),
      humanRoot: root,
    },
    rateLimitPolicy,
    txHashes,
  };
}
