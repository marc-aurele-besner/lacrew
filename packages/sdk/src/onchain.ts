/**
 * Viem-backed onchain LaCrew client.
 * Mock remains the SDK default; use createOnchainClient for Anvil / testnets.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  keccak256,
  toBytes,
  type Account,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
  type PublicClient,
} from "viem";
import {
  ANVIL_CHAIN_ID,
  getAddresses,
  orgRegistryAbi,
  treasuryAbi,
  escalationRouterAbi,
  governanceModuleAbi,
  epochStreamerAbi,
  sessionRegistryAbi,
  spendCapPolicyAbi,
  whitelistPolicyAbi,
  policyModuleAbi,
  marketplacePaymentsAbi,
  mockUsdcAbi,
  type Allowance,
  type ChainAddresses,
  type GovernanceProposal,
  type GovernanceProposalState,
  type GovernanceTier,
  type Intent,
  type OrgNode,
  type ProtocolEvent,
  type SessionKey,
  type Verdict,
} from "@lacrew/core";

const TIER_MAP: Record<GovernanceTier, number> = {
  low: 0,
  high: 1,
};

const TIER_FROM: Record<number, GovernanceTier> = {
  0: "low",
  1: "high",
};

const STATE_FROM: Record<number, GovernanceProposalState> = {
  0: "active",
  1: "executed",
  2: "vetoed",
  3: "defeated",
};

const NODE_KIND_MAP: Record<OrgNode["kind"], number> = {
  human_root: 0,
  manager_agent: 1,
  worker_agent: 2,
};

export type OnchainResolveResult = {
  intent: Intent;
  escalated: boolean;
  txHash: `0x${string}`;
};

const KIND_MAP: Record<number, OrgNode["kind"]> = {
  0: "human_root",
  1: "manager_agent",
  2: "worker_agent",
};

const VERDICT_MAP: Record<number, Verdict> = {
  0: "ALLOW",
  1: "ESCALATE",
  2: "DENY",
};

export type OnchainClientOptions = {
  transport: Transport;
  /** Wallet account for writes (propose); reads work without it. */
  account?: Account;
  /**
   * Optional second account for resolve (e.g. Anvil manager).
   * Falls back to `account` when omitted.
   */
  resolverAccount?: Account;
  chain?: Chain;
  chainId?: number;
  addresses?: ChainAddresses;
  /** Optional path or URL for lightweight indexer JSON (see @lacrew/indexer). */
  indexerPath?: string;
};

export class OnchainLacrewClient {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | null;
  readonly resolverWalletClient: WalletClient | null;
  readonly addresses: ChainAddresses;
  readonly chainId: number;
  private readonly transport: Transport;
  private readonly chain: Chain | undefined;
  private readonly indexerPath?: string;

  constructor(options: OnchainClientOptions) {
    this.chainId = options.chainId ?? options.addresses?.chainId ?? ANVIL_CHAIN_ID;
    this.addresses = options.addresses ?? getAddresses(this.chainId);
    this.indexerPath = options.indexerPath ?? process.env.INDEXER_PATH ?? process.env.INDEXER_URL;
    this.transport = options.transport;
    this.chain = options.chain;
    this.publicClient = createPublicClient({
      transport: options.transport,
      chain: options.chain,
    });
    this.walletClient = options.account
      ? createWalletClient({
          account: options.account,
          transport: options.transport,
          chain: options.chain,
        })
      : null;
    this.resolverWalletClient = options.resolverAccount
      ? createWalletClient({
          account: options.resolverAccount,
          transport: options.transport,
          chain: options.chain,
        })
      : this.walletClient;
  }

  async getOrgTree(): Promise<OrgNode[]> {
    const root = (await this.publicClient.readContract({
      address: this.addresses.orgRegistry,
      abi: orgRegistryAbi,
      functionName: "root",
    })) as `0x${string}`;

    const nodes: OrgNode[] = [];
    const queue: `0x${string}`[] = [root];
    const seen = new Set<string>();

    while (queue.length) {
      const account = queue.shift()!;
      if (seen.has(account.toLowerCase())) continue;
      seen.add(account.toLowerCase());

      const node = (await this.publicClient.readContract({
        address: this.addresses.orgRegistry,
        abi: orgRegistryAbi,
        functionName: "getNode",
        args: [account],
      })) as {
        account: `0x${string}`;
        kind: number;
        parent: `0x${string}`;
        active: boolean;
      };

      nodes.push({
        account: node.account,
        kind: KIND_MAP[Number(node.kind)] ?? "worker_agent",
        parent:
          node.parent === "0x0000000000000000000000000000000000000000"
            ? null
            : node.parent,
        active: node.active,
      });

      const children = (await this.publicClient.readContract({
        address: this.addresses.orgRegistry,
        abi: orgRegistryAbi,
        functionName: "getChildren",
        args: [account],
      })) as `0x${string}`[];
      queue.push(...children);
    }

    return nodes;
  }

  async getAllowances(node?: `0x${string}`): Promise<Allowance[]> {
    const tree = await this.getOrgTree();
    const targets = node
      ? tree.filter((n) => n.account.toLowerCase() === node.toLowerCase())
      : tree;
    const token = (this.addresses.mockUSDC ??
      "0x0000000000000000000000000000000000000000") as `0x${string}`;

    const out: Allowance[] = [];
    for (const n of targets) {
      const balance = (await this.publicClient.readContract({
        address: this.addresses.treasury,
        abi: treasuryAbi,
        functionName: "allowanceBalance",
        args: [n.account],
      })) as bigint;
      if (balance === 0n && n.kind === "human_root") continue;
      out.push({
        node: n.account,
        token,
        balance,
        epoch: 1,
        cap: balance,
      });
    }
    return out;
  }

  /** Scan EscalationRouter intents(1..next-1) for unresolved rows (no indexer required). */
  async getPendingIntents(): Promise<Intent[]> {
    const next = (await this.publicClient.readContract({
      address: this.addresses.escalationRouter,
      abi: escalationRouterAbi,
      functionName: "nextIntentId",
    })) as bigint;

    const out: Intent[] = [];
    for (let id = 1n; id < next; id++) {
      const intent = await this.readIntent(id);
      if (!intent.resolved) out.push(intent);
    }
    return out;
  }

  async getAuditTrail(): Promise<ProtocolEvent[]> {
    const store = await this.readIndexer();
    return store?.audit ?? [];
  }

  /**
   * Read a verdict from an IPolicyModule without proposing anything.
   * Defaults to the org's PolicyStack (falls back to SpendCapPolicy when no
   * stack is deployed); pass `policyModule` to target a specific module.
   */
  async checkPolicy(input: {
    agent: `0x${string}`;
    target: `0x${string}`;
    value: bigint;
    data?: Hex;
    policyModule?: `0x${string}`;
  }): Promise<Verdict> {
    const module = input.policyModule ?? this.addresses.policyStack ?? this.addresses.spendCapPolicy;
    if (!module || module === "0x0000000000000000000000000000000000000000") {
      throw new Error(
        `No policy module configured for chain ${this.chainId}: set addresses.policyStack or pass policyModule`,
      );
    }

    const verdict = (await this.publicClient.readContract({
      address: module,
      abi: policyModuleAbi,
      functionName: "check",
      args: [input.agent, input.target, input.value, input.data ?? "0x"],
    })) as number;

    return VERDICT_MAP[verdict] ?? "DENY";
  }

  /**
   * Propose via EscalationRouter.
   * When SessionRegistry is wired, `account` must be a valid session key for `agent`
   * (or the agent address itself). Root wallet alone is not enough.
   */
  async proposeIntent(input: {
    agent: `0x${string}`;
    target: `0x${string}`;
    value: bigint;
    data?: Hex;
    /** Session-key (or agent) account that signs `propose`. Defaults to root wallet. */
    account?: Account;
  }): Promise<{ intentId: string; verdict: Verdict; txHash: `0x${string}` }> {
    const wallet = input.account
      ? createWalletClient({
          account: input.account,
          transport: this.transport,
          chain: this.chain,
        })
      : this.requireWallet();
    const signer = wallet.account;
    if (!signer) {
      throw new Error("proposeIntent requires a signer account");
    }
    const { request, result } = await this.publicClient.simulateContract({
      address: this.addresses.escalationRouter,
      abi: escalationRouterAbi,
      functionName: "propose",
      args: [input.agent, input.target, input.value, input.data ?? "0x"],
      account: signer,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`propose reverted: ${hash}`);
    }
    const [intentIdRaw, verdictRaw] = result as [bigint, number];
    return {
      intentId: intentIdRaw.toString(),
      verdict: VERDICT_MAP[Number(verdictRaw)] ?? "ESCALATE",
      txHash: hash,
    };
  }

  /**
   * Dry-run an approval (viem eth_call through router.resolve → finalize →
   * the agent's actual target call) without signing. PRD F1.16.
   */
  async simulateResolveApproval(
    intentId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const wallet = this.requireResolverWallet();
    try {
      await this.publicClient.simulateContract({
        address: this.addresses.escalationRouter,
        abi: escalationRouterAbi,
        functionName: "resolve",
        args: [BigInt(intentId), true],
        account: wallet.account!,
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // First line of the viem error carries the decoded revert reason.
      return { ok: false, reason: message.split("\n")[0] };
    }
  }

  async resolveIntent(
    intentId: string,
    approved: boolean,
    _approver?: `0x${string}`,
  ): Promise<OnchainResolveResult> {
    const wallet = this.requireResolverWallet();
    const id = BigInt(intentId);
    const hash = await wallet.writeContract({
      address: this.addresses.escalationRouter,
      abi: escalationRouterAbi,
      functionName: "resolve",
      args: [id, approved],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    const intent = await this.readIntent(id);
    return {
      intent,
      escalated: !intent.resolved && intent.awaitingApprover !== null,
      txHash: hash,
    };
  }

  async getSessions(agent?: `0x${string}`): Promise<SessionKey[]> {
    const addr = this.addresses.sessionRegistry;
    if (!addr) return [];

    const agents: `0x${string}`[] = agent
      ? [agent]
      : ((await this.getOrgTree()).map((n) => n.account) as `0x${string}`[]);

    const out: SessionKey[] = [];
    const nowSec = Math.floor(Date.now() / 1000);

    for (const a of agents) {
      const ids = (await this.publicClient.readContract({
        address: addr,
        abi: sessionRegistryAbi,
        functionName: "sessionsOf",
        args: [a],
      })) as readonly bigint[];

      for (const id of ids) {
        const row = (await this.publicClient.readContract({
          address: addr,
          abi: sessionRegistryAbi,
          functionName: "sessions",
          args: [id],
        })) as readonly [
          `0x${string}`,
          `0x${string}`,
          number | bigint,
          `0x${string}`,
          bigint,
          `0x${string}`,
          boolean,
          boolean,
        ];
        const [, key, expiresAtRaw, , maxValue, allowedTarget, revoked, exists] = row;
        if (!exists) continue;
        const expiresAtSec = Number(expiresAtRaw);
        out.push({
          agent: a,
          keyId: id.toString(),
          keyAddress: key,
          expiresAt: expiresAtSec * 1000,
          scopes: [],
          maxValue: maxValue.toString(),
          allowedTarget,
          revoked: revoked || expiresAtSec <= nowSec,
        });
      }
    }
    return out.sort((x, y) => y.expiresAt - x.expiresAt);
  }

  // ——— Marketplace settlement ———
  //
  // Deliberately separate from the intent/allowance path: a purchase is a buyer
  // paying a seller, not an org spending its own budget, so it never touches
  // Treasury allowances or the escalation router.

  private requireMarketplace(): `0x${string}` {
    const addr = this.addresses.marketplacePayments;
    if (!addr || addr === "0x0000000000000000000000000000000000000000") {
      throw new Error("marketplacePayments address missing — redeploy with DeployMockOrg");
    }
    return addr;
  }

  /** Catalog ids are strings off-chain; onchain they are their keccak hash. */
  static listingId(catalogId: string): `0x${string}` {
    return keccak256(toBytes(catalogId));
  }

  /** Price and split for a listing, at the fee currently in force. */
  async quoteListing(
    catalogId: string,
  ): Promise<{ gross: bigint; fee: bigint; net: bigint; feeBps: number }> {
    const address = this.requireMarketplace();
    const [quote, feeBps] = await Promise.all([
      this.publicClient.readContract({
        address,
        abi: marketplacePaymentsAbi,
        functionName: "quote",
        args: [OnchainLacrewClient.listingId(catalogId)],
      }) as Promise<readonly [bigint, bigint, bigint]>,
      this.publicClient.readContract({
        address,
        abi: marketplacePaymentsAbi,
        functionName: "feeBps",
      }) as Promise<number>,
    ]);
    return { gross: quote[0], fee: quote[1], net: quote[2], feeBps: Number(feeBps) };
  }

  async getListing(
    catalogId: string,
  ): Promise<{ seller: `0x${string}`; price: bigint; active: boolean } | undefined> {
    const result = (await this.publicClient.readContract({
      address: this.requireMarketplace(),
      abi: marketplacePaymentsAbi,
      functionName: "listings",
      args: [OnchainLacrewClient.listingId(catalogId)],
    })) as readonly [`0x${string}`, bigint, boolean];
    const [seller, price, active] = result;
    if (seller === "0x0000000000000000000000000000000000000000") return undefined;
    return { seller, price, active };
  }

  /** True once `buyer` holds a receipt for `catalogId`. */
  async hasPurchased(catalogId: string, buyer: `0x${string}`): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.requireMarketplace(),
      abi: marketplacePaymentsAbi,
      functionName: "hasPurchased",
      args: [OnchainLacrewClient.listingId(catalogId), buyer],
    })) as boolean;
  }

  /** List (or reprice) a listing the calling wallet sells. */
  async registerListing(input: {
    catalogId: string;
    price: bigint;
  }): Promise<{ txHash: `0x${string}`; listingId: `0x${string}` }> {
    const wallet = this.requireWallet();
    const listingId = OnchainLacrewClient.listingId(input.catalogId);
    const hash = await wallet.writeContract({
      address: this.requireMarketplace(),
      abi: marketplacePaymentsAbi,
      functionName: "registerListing",
      args: [listingId, input.price],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash, listingId };
  }

  /**
   * Buy a listing, approving the exact gross first when the current ERC20
   * allowance is short.
   *
   * `maxPrice` defaults to the quoted gross, so a seller repricing between the
   * quote and the send makes the purchase revert rather than overcharge.
   */
  async purchaseListing(input: {
    catalogId: string;
    maxPrice?: bigint;
  }): Promise<{ txHash: `0x${string}`; gross: bigint; fee: bigint; net: bigint }> {
    const wallet = this.requireWallet();
    const market = this.requireMarketplace();
    const buyer = wallet.account!.address;
    const { gross, fee, net } = await this.quoteListing(input.catalogId);
    const maxPrice = input.maxPrice ?? gross;

    const token = (await this.publicClient.readContract({
      address: market,
      abi: marketplacePaymentsAbi,
      functionName: "token",
    })) as `0x${string}`;

    if (gross > 0n) {
      const allowance = (await this.publicClient.readContract({
        address: token,
        abi: mockUsdcAbi,
        functionName: "allowance",
        args: [buyer, market],
      })) as bigint;
      if (allowance < gross) {
        const approveHash = await wallet.writeContract({
          address: token,
          abi: mockUsdcAbi,
          functionName: "approve",
          args: [market, gross],
          account: wallet.account!,
          chain: wallet.chain,
        });
        await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
      }
    }

    const hash = await wallet.writeContract({
      address: market,
      abi: marketplacePaymentsAbi,
      functionName: "purchase",
      args: [OnchainLacrewClient.listingId(input.catalogId), maxPrice],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash, gross, fee, net };
  }

  /** Balance accrued to `payee` and awaiting withdrawal. */
  async marketplaceEarnings(payee: `0x${string}`): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.requireMarketplace(),
      abi: marketplacePaymentsAbi,
      functionName: "owed",
      args: [payee],
    })) as bigint;
  }

  /** Withdraw everything accrued to the calling wallet. */
  async withdrawMarketplaceEarnings(): Promise<{ txHash: `0x${string}` }> {
    const wallet = this.requireWallet();
    const hash = await wallet.writeContract({
      address: this.requireMarketplace(),
      abi: marketplacePaymentsAbi,
      functionName: "withdraw",
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  /** Send ETH from the root wallet (Phase 0 gas sponsorship for session keys). */
  async fundEth(
    to: `0x${string}`,
    value: bigint,
  ): Promise<{ txHash: `0x${string}` }> {
    const wallet = this.requireWallet();
    const hash = await wallet.sendTransaction({
      to,
      value,
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  /** Register an ephemeral key on SessionRegistry (caller = root or issuer). */
  async issueSession(input: {
    agent: `0x${string}`;
    key: `0x${string}`;
    expiresAtSec: number;
    scopesHash: `0x${string}`;
    /** Max propose value; defaults to max uint256 (unlimited). */
    maxValue?: bigint;
    /** Sole allowed target; defaults to zero (any policy-allowed target). */
    allowedTarget?: `0x${string}`;
  }): Promise<{ sessionId: string; txHash: `0x${string}` }> {
    const addr = this.addresses.sessionRegistry;
    if (!addr) throw new Error("sessionRegistry address missing — redeploy with DeployMockOrg");
    const wallet = this.requireWallet();
    const maxValue = input.maxValue ?? 2n ** 256n - 1n;
    const allowedTarget =
      input.allowedTarget ?? "0x0000000000000000000000000000000000000000";
    const { request, result } = await this.publicClient.simulateContract({
      address: addr,
      abi: sessionRegistryAbi,
      functionName: "issue",
      args: [
        input.agent,
        input.key,
        BigInt(input.expiresAtSec),
        input.scopesHash,
        maxValue,
        allowedTarget,
      ],
      account: wallet.account!,
    });
    const hash = await wallet.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { sessionId: (result as bigint).toString(), txHash: hash };
  }

  async revokeSession(sessionId: string): Promise<{ txHash: `0x${string}` }> {
    const addr = this.addresses.sessionRegistry;
    if (!addr) throw new Error("sessionRegistry address missing — redeploy with DeployMockOrg");
    const wallet = this.requireWallet();
    const hash = await wallet.writeContract({
      address: addr,
      abi: sessionRegistryAbi,
      functionName: "revoke",
      args: [BigInt(sessionId)],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  /** Current payroll epoch from EpochStreamer (0 if not deployed). */
  async getCurrentEpoch(): Promise<number> {
    const addr = this.addresses.epochStreamer;
    if (!addr) return 0;
    const epoch = (await this.publicClient.readContract({
      address: addr,
      abi: epochStreamerAbi,
      functionName: "currentEpoch",
    })) as bigint;
    return Number(epoch);
  }

  /**
   * Run the next payroll epoch via EpochStreamer (operator = wallet account).
   * Streams configured grants into node allowances.
   */
  async runEpoch(): Promise<{ epoch: number; txHash: `0x${string}` }> {
    const addr = this.addresses.epochStreamer;
    if (!addr) {
      throw new Error("epochStreamer address missing — redeploy with DeployMockOrg");
    }
    const wallet = this.requireWallet();
    const { request, result } = await this.publicClient.simulateContract({
      address: addr,
      abi: epochStreamerAbi,
      functionName: "runNextEpoch",
      account: wallet.account!,
    });
    const hash = await wallet.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { epoch: Number(result as bigint), txHash: hash };
  }

  /** Read all proposals (1 .. nextProposalId-1). */
  async getProposals(): Promise<GovernanceProposal[]> {
    const next = (await this.publicClient.readContract({
      address: this.addresses.governanceModule,
      abi: governanceModuleAbi,
      functionName: "nextProposalId",
    })) as bigint;
    const out: GovernanceProposal[] = [];
    for (let id = 1n; id < next; id++) {
      out.push(await this.readProposal(id));
    }
    return out;
  }

  async getProposal(proposalId: string): Promise<GovernanceProposal> {
    return this.readProposal(BigInt(proposalId));
  }

  /**
   * Propose hiring a node via OrgRegistry.addNode (low tier by default).
   * Generates a deterministic demo address from `label` when `account` omitted.
   */
  async proposeHire(input: {
    label: string;
    kind?: OrgNode["kind"];
    parent?: `0x${string}`;
    account?: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash: `0x${string}` }> {
    const kind = input.kind ?? "worker_agent";
    const parent =
      input.parent ??
      this.addresses.manager ??
      this.addresses.humanRoot ??
      ("0x0000000000000000000000000000000000000000" as `0x${string}`);
    const account =
      input.account ??
      (`0x${keccak256(toBytes(`lacrew.hire:${input.label}`)).slice(26)}` as `0x${string}`);
    const data = encodeFunctionData({
      abi: orgRegistryAbi,
      functionName: "addNode",
      args: [account, NODE_KIND_MAP[kind], parent],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "low",
      target: this.addresses.orgRegistry,
      data,
    });
    return { ...result, account };
  }

  /** Propose firing a node via OrgRegistry.removeNode (children rewire to parent). */
  async proposeFire(input: {
    account: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash: `0x${string}` }> {
    const data = encodeFunctionData({
      abi: orgRegistryAbi,
      functionName: "removeNode",
      args: [input.account],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "low",
      target: this.addresses.orgRegistry,
      data,
    });
    return { ...result, account: input.account };
  }

  /**
   * Propose suspending or restoring a node via OrgRegistry.setActive.
   * Unlike proposeFire (removeNode, which rewires children to the parent and
   * cannot be undone), this is reversible: an inactive node keeps its place in
   * the chart and can be switched back on.
   */
  /**
   * Read an agent's spend cap from SpendCapPolicy. Used to derive session-key
   * ceilings, where the cap must be known as a number rather than a verdict.
   * Returns undefined when no SpendCapPolicy is deployed.
   */
  async capOf(agent: `0x${string}`): Promise<bigint | undefined> {
    const addr = this.addresses.spendCapPolicy;
    if (!addr || addr === "0x0000000000000000000000000000000000000000") return undefined;
    return (await this.publicClient.readContract({
      address: addr,
      abi: spendCapPolicyAbi,
      functionName: "capOf",
      args: [agent],
    })) as bigint;
  }

  async proposeSetActive(input: {
    account: `0x${string}`;
    active: boolean;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash: `0x${string}` }> {
    const data = encodeFunctionData({
      abi: orgRegistryAbi,
      functionName: "setActive",
      args: [input.account, input.active],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "low",
      target: this.addresses.orgRegistry,
      data,
    });
    return { ...result, account: input.account };
  }

  /** Propose moving a node under a new parent via OrgRegistry.reparent. */
  async proposeReparent(input: {
    account: `0x${string}`;
    newParent: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash: `0x${string}` }> {
    const data = encodeFunctionData({
      abi: orgRegistryAbi,
      functionName: "reparent",
      args: [input.account, input.newParent],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "low",
      target: this.addresses.orgRegistry,
      data,
    });
    return { ...result, account: input.account };
  }

  /**
   * Propose changing a node's per-epoch grant (EpochStreamer.setGrant).
   * Defaults to high tier — budget-touching / human final say.
   */
  async proposeSetGrant(input: {
    account: `0x${string}`;
    amount: bigint;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash: `0x${string}` }> {
    const addr = this.addresses.epochStreamer;
    if (!addr) {
      throw new Error("epochStreamer address missing — redeploy with DeployMockOrg");
    }
    const data = encodeFunctionData({
      abi: epochStreamerAbi,
      functionName: "setGrant",
      args: [input.account, input.amount],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "high",
      target: addr,
      data,
    });
    return { ...result, account: input.account };
  }

  /** Propose EscalationRouter.setNodePolicy (high tier — policy upgrade). */
  async proposeSetNodePolicy(input: {
    node: `0x${string}`;
    policyModule: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; node: `0x${string}`; txHash: `0x${string}` }> {
    const data = encodeFunctionData({
      abi: escalationRouterAbi,
      functionName: "setNodePolicy",
      args: [input.node, input.policyModule],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "high",
      target: this.addresses.escalationRouter,
      data,
    });
    return { ...result, node: input.node };
  }

  /** Propose WhitelistPolicy.setAllowed (high tier). */
  async proposeSetWhitelist(input: {
    target: `0x${string}`;
    allowed: boolean;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; target: `0x${string}`; txHash: `0x${string}` }> {
    const addr = this.addresses.whitelistPolicy;
    if (!addr) throw new Error("whitelistPolicy address missing");
    const data = encodeFunctionData({
      abi: whitelistPolicyAbi,
      functionName: "setAllowed",
      args: [input.target, input.allowed],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "high",
      target: addr,
      data,
    });
    return { ...result, target: input.target };
  }

  /** Propose SpendCapPolicy.setAgentCap (high tier). */
  async proposeSetAgentCap(input: {
    agent: `0x${string}`;
    cap: bigint;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; agent: `0x${string}`; txHash: `0x${string}` }> {
    const addr = this.addresses.spendCapPolicy;
    if (!addr) throw new Error("spendCapPolicy address missing");
    const data = encodeFunctionData({
      abi: spendCapPolicyAbi,
      functionName: "setAgentCap",
      args: [input.agent, input.cap],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "high",
      target: addr,
      data,
    });
    return { ...result, agent: input.agent };
  }

  /** Propose a constitutional action (target + calldata). */
  async proposeGovernance(input: {
    tier: GovernanceTier;
    target: `0x${string}`;
    data: Hex;
  }): Promise<{ proposalId: string; txHash: `0x${string}` }> {
    const wallet = this.requireWallet();
    const { request, result } = await this.publicClient.simulateContract({
      address: this.addresses.governanceModule,
      abi: governanceModuleAbi,
      functionName: "propose",
      args: [TIER_MAP[input.tier], input.target, input.data],
      account: wallet.account!,
    });
    const hash = await wallet.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { proposalId: (result as bigint).toString(), txHash: hash };
  }

  /**
   * Cast a yes/no vote.
   * When `useResolver` is true, signs with resolverAccount (demo second voter for quorum).
   */
  async voteGovernance(
    proposalId: string,
    support: boolean,
    opts?: { useResolver?: boolean },
  ): Promise<{ txHash: `0x${string}` }> {
    const wallet = opts?.useResolver ? this.requireResolverWallet() : this.requireWallet();
    const hash = await wallet.writeContract({
      address: this.addresses.governanceModule,
      abi: governanceModuleAbi,
      functionName: "vote",
      args: [BigInt(proposalId), support],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  async vetoGovernance(proposalId: string): Promise<{ txHash: `0x${string}` }> {
    const wallet = this.requireWallet();
    const hash = await wallet.writeContract({
      address: this.addresses.governanceModule,
      abi: governanceModuleAbi,
      functionName: "veto",
      args: [BigInt(proposalId)],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  async executeGovernance(proposalId: string): Promise<{ txHash: `0x${string}` }> {
    const wallet = this.requireWallet();
    const hash = await wallet.writeContract({
      address: this.addresses.governanceModule,
      abi: governanceModuleAbi,
      functionName: "execute",
      args: [BigInt(proposalId)],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  private async readProposal(id: bigint): Promise<GovernanceProposal> {
    const row = (await this.publicClient.readContract({
      address: this.addresses.governanceModule,
      abi: governanceModuleAbi,
      functionName: "proposals",
      args: [id],
    })) as readonly [
      `0x${string}`,
      number,
      `0x${string}`,
      `0x${string}`,
      Hex,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      number,
    ];
    return {
      id: id.toString(),
      proposer: row[0],
      tier: TIER_FROM[row[1]] ?? "low",
      target: row[2],
      actionHash: row[3],
      data: row[4],
      yesVotes: Number(row[5]),
      noVotes: Number(row[6]),
      yesHumanVotes: Number(row[7]),
      deadline: Number(row[8]),
      eta: Number(row[9]),
      state: STATE_FROM[row[10]] ?? "active",
    };
  }

  private requireWallet(): WalletClient {
    if (!this.walletClient?.account) {
      throw new Error("Onchain writes require an account (createOnchainClient({ account }))");
    }
    return this.walletClient;
  }

  private requireResolverWallet(): WalletClient {
    if (!this.resolverWalletClient?.account) {
      throw new Error(
        "Onchain resolve requires an account (createOnchainClient({ account }) or resolverAccount)",
      );
    }
    return this.resolverWalletClient;
  }

  private async readIntent(id: bigint): Promise<Intent> {
    if (id === 0n) {
      return {
        id: "0",
        agent: "0x0000000000000000000000000000000000000000",
        target: "0x0000000000000000000000000000000000000000",
        value: 0n,
        data: "0x",
        awaitingApprover: null,
        resolved: true,
        approved: true,
        verdict: "ALLOW",
      };
    }
    const row = (await this.publicClient.readContract({
      address: this.addresses.escalationRouter,
      abi: escalationRouterAbi,
      functionName: "intents",
      args: [id],
    })) as readonly [
      `0x${string}`,
      `0x${string}`,
      bigint,
      Hex,
      `0x${string}`,
      boolean,
      boolean,
    ];

    const [agent, target, value, data, awaitingApprover, resolved, approved] = row;

    return {
      id: id.toString(),
      agent,
      target,
      value,
      data,
      awaitingApprover:
        awaitingApprover === "0x0000000000000000000000000000000000000000"
          ? null
          : awaitingApprover,
      resolved,
      approved: resolved ? approved : null,
      verdict: resolved ? (approved ? "ALLOW" : "DENY") : "ESCALATE",
    };
  }

  private async readIndexer(): Promise<{
    pendingIntents: Intent[];
    audit: ProtocolEvent[];
  } | null> {
    if (!this.indexerPath) return null;
    try {
      if (this.indexerPath.startsWith("http://") || this.indexerPath.startsWith("https://")) {
        const res = await fetch(this.indexerPath);
        if (!res.ok) return null;
        return (await res.json()) as { pendingIntents: Intent[]; audit: ProtocolEvent[] };
      }
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.indexerPath, "utf8");
      return JSON.parse(raw, (_k, v) => {
        if (typeof v === "string" && /^\d+n$/.test(v)) return BigInt(v.slice(0, -1));
        return v;
      }) as { pendingIntents: Intent[]; audit: ProtocolEvent[] };
    } catch {
      return null;
    }
  }
}

export function createOnchainClient(options: OnchainClientOptions): OnchainLacrewClient {
  return new OnchainLacrewClient(options);
}

export { VERDICT_MAP };
