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
  resolveAssetStack,
  sessionScopesFromMask,
  type Allowance,
  type ChainAddresses,
  type GovernanceConfig,
  type GovernanceProposal,
  type GovernanceProposalState,
  type GovernanceSeat,
  type GovernanceSeatRole,
  type GovernanceTier,
  type Intent,
  type OrgNode,
  type ProtocolEvent,
  type SessionKey,
  type Verdict,
} from "@lacrew/core";
import { resolveWorkspacePath } from "@lacrew/core/node";

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

/** SeatRole enum order in GovernanceModule: None, Human, Agent. */
const SEAT_ROLE_FROM: Record<number, GovernanceSeatRole> = {
  0: "none",
  1: "human",
  2: "agent",
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
  /**
   * Optional account for session-key issuance/revocation (`SessionRegistry`).
   * Falls back to `account` when omitted. Splitting it lets the issuer be a key
   * the process running proposals does not hold — the registry gates `issue` on
   * root-or-issuer, so root can authorise this account via `setIssuer` and keep
   * the root key itself out of the orchestrator.
   */
  issuerAccount?: Account;
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
  readonly issuerWalletClient: WalletClient | null;
  readonly addresses: ChainAddresses;
  readonly chainId: number;
  private readonly transport: Transport;
  private readonly chain: Chain | undefined;
  private readonly indexerPath?: string;

  constructor(options: OnchainClientOptions) {
    this.chainId = options.chainId ?? options.addresses?.chainId ?? ANVIL_CHAIN_ID;
    this.addresses = options.addresses ?? getAddresses(this.chainId);
    // Anchored to the workspace root so this resolves to the same file the
    // indexer writes, which runs from a different cwd. A URL passes through.
    const rawIndexer = options.indexerPath ?? process.env.INDEXER_PATH ?? process.env.INDEXER_URL;
    this.indexerPath = rawIndexer ? resolveWorkspacePath(rawIndexer) : undefined;
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
    this.issuerWalletClient = options.issuerAccount
      ? createWalletClient({
          account: options.issuerAccount,
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

  /**
   * Allowances for the org, denominated in one asset.
   *
   * `asset` selects the enforcement stack (symbol or token address); omit it for
   * the primary (USDC) stack. Balances, cap and epoch are all read from that
   * asset's own Treasury / SpendCapPolicy / EpochStreamer, so a WETH read never
   * borrows USDC's bookkeeping.
   */
  async getAllowances(node?: `0x${string}`, asset?: string): Promise<Allowance[]> {
    const stack = resolveAssetStack(this.addresses, asset);
    const tree = await this.getOrgTree();
    const targets = node
      ? tree.filter((n) => n.account.toLowerCase() === node.toLowerCase())
      : tree;
    const token = stack.token;

    // The epoch is a property of the streamer, not of any one agent, so it is
    // read once rather than per node. `epoch: 1` used to be hardcoded, which
    // made every allowance claim to be from the first epoch forever.
    const streamer = stack.epochStreamer;
    const epoch =
      streamer && streamer !== "0x0000000000000000000000000000000000000000"
        ? Number(
            (await this.publicClient.readContract({
              address: streamer,
              abi: epochStreamerAbi,
              functionName: "currentEpoch",
            })) as bigint,
          )
        : 0;

    const out: Allowance[] = [];
    for (const n of targets) {
      const [balance, cap] = await Promise.all([
        this.publicClient.readContract({
          address: stack.treasury,
          abi: treasuryAbi,
          functionName: "allowanceBalance",
          args: [n.account],
        }) as Promise<bigint>,
        this.readAgentCap(n.account, stack.spendCapPolicy),
      ]);
      if (balance === 0n && n.kind === "human_root") continue;
      out.push({ node: n.account, token, balance, epoch, cap });
    }
    return out;
  }

  /**
   * The spend ceiling SpendCapPolicy will actually enforce for this agent.
   *
   * `capOf` is the right read, not `agentCap`: an agent with no specific cap
   * inherits `defaultCap`, and `check()` compares against `capOf`, so the
   * inherited value is every bit as binding as an explicit one. There is no
   * uncapped agent while the module is in the stack.
   *
   * Null therefore means "this dimension is not enforced here" — no
   * SpendCapPolicy deployed — rather than "no limit set for this agent".
   */
  private async readAgentCap(
    agent: `0x${string}`,
    spendCapPolicy: `0x${string}` | undefined = this.addresses.spendCapPolicy,
  ): Promise<bigint | null> {
    if (!spendCapPolicy) return null;
    return (await this.publicClient.readContract({
      address: spendCapPolicy,
      abi: spendCapPolicyAbi,
      functionName: "capOf",
      args: [agent],
    })) as bigint;
  }

  /**
   * Resolve an asset's EpochStreamer address, or undefined when the stack has
   * no streamer (a bare address book carries the zero address for it).
   */
  private assetStreamer(asset?: string): `0x${string}` | undefined {
    const addr = resolveAssetStack(this.addresses, asset).epochStreamer;
    return addr && addr !== "0x0000000000000000000000000000000000000000"
      ? addr
      : undefined;
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
          bigint,
          bigint,
          `0x${string}`,
          boolean,
          boolean,
          number,
          number,
        ];
        const [, key, expiresAtRaw, scopeMask, maxValue, allowedTarget, revoked, exists, windowStart, windowEnd] =
          row;
        if (!exists) continue;
        const expiresAtSec = Number(expiresAtRaw);
        // Rate lives in its own mapping, not the Session struct — one more read.
        const rl = (await this.publicClient.readContract({
          address: addr,
          abi: sessionRegistryAbi,
          functionName: "rateLimits",
          args: [id],
        })) as readonly [number, number, bigint, number];
        const maxProposals = rl[0];
        out.push({
          agent: a,
          keyId: id.toString(),
          keyAddress: key,
          expiresAt: expiresAtSec * 1000,
          scopes: sessionScopesFromMask(scopeMask),
          maxValue: maxValue.toString(),
          allowedTarget,
          // A zero end means no window; otherwise report the daily [start, end).
          window: windowEnd === 0 ? undefined : { start: windowStart, end: windowEnd },
          // A zero cap means no rate limit; otherwise report maxProposals / ratePeriod.
          rate: maxProposals === 0 ? undefined : { maxProposals, ratePeriod: rl[1] },
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

  /**
   * Buy a listing with org funds instead of a personal wallet.
   *
   * The purchase is an ordinary policy-checked spend: it goes through
   * EscalationRouter, so the agent's spend cap, whitelist, rate limit, and time
   * window all apply, an over-cap purchase ESCALATEs to a human, and the whole
   * thing lands in the audit trail like any other intent. The marketplace
   * contract must be whitelisted and set as the settlement router (DeployMockOrg
   * does both).
   *
   * Returns the router's verdict — `escalate` means a human still has to approve
   * before the seller is paid, so callers must not report a purchase as complete
   * on anything but `allow`.
   */
  async proposeMarketplacePurchase(input: {
    agent: `0x${string}`;
    catalogId: string;
    /** Who receives the entitlement. Defaults to the paying agent. */
    buyer?: `0x${string}`;
    maxPrice?: bigint;
    account?: Account;
  }): Promise<{
    intentId: string;
    verdict: Verdict;
    txHash: `0x${string}`;
    gross: bigint;
    fee: bigint;
    net: bigint;
  }> {
    const market = this.requireMarketplace();
    const { gross, fee, net } = await this.quoteListing(input.catalogId);
    const buyer = input.buyer ?? input.agent;
    const data = encodeFunctionData({
      abi: marketplacePaymentsAbi,
      functionName: "purchaseFor",
      args: [
        OnchainLacrewClient.listingId(input.catalogId),
        buyer,
        input.maxPrice ?? gross,
      ],
    });
    const result = await this.proposeIntent({
      agent: input.agent,
      target: market,
      value: gross,
      data,
      account: input.account,
    });
    return { ...result, gross, fee, net };
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
    /** Scope bitmask; see `sessionScopeMask` in @lacrew/core. */
    scopeMask: bigint;
    /** Max propose value; defaults to max uint256 (unlimited). */
    maxValue?: bigint;
    /** Sole allowed target; defaults to zero (any policy-allowed target). */
    allowedTarget?: `0x${string}`;
    /**
     * Daily allowed window in seconds since midnight UTC, `[start, end)`. Carries
     * a flow's time-window scope onto the key so the chain refuses a propose
     * outside it. Omit for a key valid at any time.
     */
    window?: { start: number; end: number };
    /**
     * Propose rate limit: at most `maxProposals` per `ratePeriod` seconds,
     * enforced by EscalationRouter. Omit for an unlimited key.
     */
    rate?: { maxProposals: number; ratePeriod: number };
  }): Promise<{ sessionId: string; txHash: `0x${string}` }> {
    const addr = this.addresses.sessionRegistry;
    if (!addr) throw new Error("sessionRegistry address missing — redeploy with DeployMockOrg");
    const wallet = this.requireIssuerWallet();
    const maxValue = input.maxValue ?? 2n ** 256n - 1n;
    const allowedTarget =
      input.allowedTarget ?? "0x0000000000000000000000000000000000000000";
    // A key with a window or rate limit uses issueScopedTimed (targets as an
    // array); a plain one keeps the simpler `issue` path. Each branch simulates
    // and writes on its own, so the two request shapes never meet in one union.
    let hash: `0x${string}`;
    let sessionId: bigint;
    if (input.window || input.rate) {
      const { request, result } = await this.publicClient.simulateContract({
        address: addr,
        abi: sessionRegistryAbi,
        functionName: "issueScopedTimed",
        args: [
          input.agent,
          input.key,
          BigInt(input.expiresAtSec),
          input.scopeMask,
          maxValue,
          allowedTarget === "0x0000000000000000000000000000000000000000"
            ? []
            : [allowedTarget],
          input.window?.start ?? 0,
          input.window?.end ?? 0,
          input.rate?.maxProposals ?? 0,
          input.rate?.ratePeriod ?? 0,
        ],
        account: wallet.account!,
      });
      hash = await wallet.writeContract(request);
      sessionId = result as bigint;
    } else {
      const { request, result } = await this.publicClient.simulateContract({
        address: addr,
        abi: sessionRegistryAbi,
        functionName: "issue",
        args: [
          input.agent,
          input.key,
          BigInt(input.expiresAtSec),
          input.scopeMask,
          maxValue,
          allowedTarget,
        ],
        account: wallet.account!,
      });
      hash = await wallet.writeContract(request);
      sessionId = result as bigint;
    }
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { sessionId: sessionId.toString(), txHash: hash };
  }

  async revokeSession(sessionId: string): Promise<{ txHash: `0x${string}` }> {
    const addr = this.addresses.sessionRegistry;
    if (!addr) throw new Error("sessionRegistry address missing — redeploy with DeployMockOrg");
    const wallet = this.requireIssuerWallet();
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

  /**
   * Point `SessionRegistry` at a dedicated issuer (root-only). Lets the human
   * root authorise an orchestrator's issuer key without handing it the root key:
   * after this, `issue`/`revoke` accept that key, and only root can change it.
   */
  async setIssuer(issuer: `0x${string}`): Promise<{ txHash: `0x${string}` }> {
    const addr = this.addresses.sessionRegistry;
    if (!addr) throw new Error("sessionRegistry address missing — redeploy with DeployMockOrg");
    const wallet = this.requireWallet();
    const hash = await wallet.writeContract({
      address: addr,
      abi: sessionRegistryAbi,
      functionName: "setIssuer",
      args: [issuer],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  /** Current `SessionRegistry` issuer (root-or-this may issue/revoke). */
  async getIssuer(): Promise<`0x${string}`> {
    const addr = this.addresses.sessionRegistry;
    if (!addr) throw new Error("sessionRegistry address missing — redeploy with DeployMockOrg");
    return (await this.publicClient.readContract({
      address: addr,
      abi: sessionRegistryAbi,
      functionName: "issuer",
    })) as `0x${string}`;
  }

  /** Current payroll epoch from an asset's EpochStreamer (0 if not deployed). */
  async getCurrentEpoch(asset?: string): Promise<number> {
    const addr = this.assetStreamer(asset);
    if (!addr) return 0;
    const epoch = (await this.publicClient.readContract({
      address: addr,
      abi: epochStreamerAbi,
      functionName: "currentEpoch",
    })) as bigint;
    return Number(epoch);
  }

  /**
   * Run the next payroll epoch via an asset's EpochStreamer (operator = wallet
   * account). Streams that asset's configured grants into node allowances.
   * `asset` selects the stack (symbol or token); omit it for the primary asset.
   */
  async runEpoch(asset?: string): Promise<{ epoch: number; txHash: `0x${string}` }> {
    const addr = this.assetStreamer(asset);
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
   *
   * `asset` selects which asset's EpochStreamer the grant targets (symbol or
   * token address); omit it for the primary asset. `amount` is denominated in
   * that asset's own decimals, since caps and grants are asset-denominated.
   */
  async proposeSetGrant(input: {
    account: `0x${string}`;
    amount: bigint;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash: `0x${string}` }> {
    const addr = this.assetStreamer(input.asset);
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

  /**
   * Quorum thresholds and the root that may change them, read from the chain.
   *
   * These are the numbers `execute()` actually gates on, so a UI that shows a
   * hardcoded quorum is showing a guess. Both are *weights*, not voter counts:
   * one seat with power 5 clears a `quorumYes` of 2 alone.
   */
  async readGovernanceConfig(): Promise<GovernanceConfig> {
    const [quorumYes, quorumHumanYes, humanRoot] = await Promise.all([
      this.publicClient.readContract({
        address: this.addresses.governanceModule,
        abi: governanceModuleAbi,
        functionName: "quorumYes",
      }) as Promise<bigint>,
      this.publicClient.readContract({
        address: this.addresses.governanceModule,
        abi: governanceModuleAbi,
        functionName: "quorumHumanYes",
      }) as Promise<bigint>,
      this.publicClient.readContract({
        address: this.addresses.governanceModule,
        abi: governanceModuleAbi,
        functionName: "humanRoot",
      }) as Promise<`0x${string}`>,
    ]);
    return {
      quorumYes: quorumYes.toString(),
      quorumHumanYes: quorumHumanYes.toString(),
      humanRoot,
    };
  }

  /** One seat's current weight and role. Power "0" means it cannot vote. */
  async readGovernanceSeat(voter: `0x${string}`): Promise<GovernanceSeat> {
    const [power, role] = await Promise.all([
      this.publicClient.readContract({
        address: this.addresses.governanceModule,
        abi: governanceModuleAbi,
        functionName: "votingPower",
        args: [voter],
      }) as Promise<bigint>,
      this.publicClient.readContract({
        address: this.addresses.governanceModule,
        abi: governanceModuleAbi,
        functionName: "seatRole",
        args: [voter],
      }) as Promise<number>,
    ]);
    return { voter, power: power.toString(), role: SEAT_ROLE_FROM[role] ?? "none" };
  }

  /**
   * The electorate: every address ever given voting power, re-read at current
   * state.
   *
   * The contract exposes no enumeration — `votingPower` is a bare mapping — so
   * candidates come from `VotingPowerUpdated` logs and each is then read back
   * from state rather than trusted from the log. That matters because a seat
   * revoked after its last log entry would otherwise still look active.
   * Revoked seats (power 0) are dropped unless asked for.
   */
  async readGovernanceSeats(
    opts: { includeRevoked?: boolean; fromBlock?: bigint } = {},
  ): Promise<GovernanceSeat[]> {
    const logs = await this.publicClient.getLogs({
      address: this.addresses.governanceModule,
      event: {
        type: "event",
        name: "VotingPowerUpdated",
        inputs: [
          { name: "voter", type: "address", indexed: true },
          { name: "power", type: "uint256", indexed: false },
          { name: "role", type: "uint8", indexed: false },
        ],
      },
      fromBlock: opts.fromBlock ?? 0n,
      toBlock: "latest",
    });

    const candidates = new Set<string>();
    for (const log of logs) {
      const voter = (log as { args?: { voter?: `0x${string}` } }).args?.voter;
      if (voter) candidates.add(voter.toLowerCase());
    }

    const seats = await Promise.all(
      [...candidates].map((voter) => this.readGovernanceSeat(voter as `0x${string}`)),
    );
    const active = opts.includeRevoked ? seats : seats.filter((s) => s.power !== "0");
    // Heaviest first: who carries a vote is the question this list answers.
    return active.sort((a, b) => {
      const d = BigInt(b.power) - BigInt(a.power);
      return d > 0n ? 1 : d < 0n ? -1 : a.voter.localeCompare(b.voter);
    });
  }

  /** Whether an address has already voted on a proposal (double-vote guard). */
  async readHasVoted(proposalId: string, voter: `0x${string}`): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.addresses.governanceModule,
      abi: governanceModuleAbi,
      functionName: "hasVoted",
      args: [BigInt(proposalId), voter],
    })) as boolean;
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

  private requireIssuerWallet(): WalletClient {
    if (!this.issuerWalletClient?.account) {
      throw new Error(
        "Onchain session issuance requires an account (createOnchainClient({ account }) or issuerAccount)",
      );
    }
    return this.issuerWalletClient;
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
