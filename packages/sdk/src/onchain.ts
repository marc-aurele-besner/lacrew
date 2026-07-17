/**
 * Viem-backed onchain LaCrew client.
 * Mock remains the SDK default; use createOnchainClient for Anvil / testnets.
 */

import {
  createPublicClient,
  createWalletClient,
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
  type Allowance,
  type ChainAddresses,
  type Intent,
  type OrgNode,
  type ProtocolEvent,
  type SessionKey,
  type Verdict,
} from "@lacrew/core";
export type OnchainResolveResult = {
  intent: Intent;
  escalated: boolean;
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
  /** Wallet account for writes; reads work without it. */
  account?: Account;
  chain?: Chain;
  chainId?: number;
  addresses?: ChainAddresses;
  /** Optional path or URL for lightweight indexer JSON (see @lacrew/indexer). */
  indexerPath?: string;
};

export class OnchainLacrewClient {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | null;
  readonly addresses: ChainAddresses;
  readonly chainId: number;
  private readonly indexerPath?: string;

  constructor(options: OnchainClientOptions) {
    this.chainId = options.chainId ?? options.addresses?.chainId ?? ANVIL_CHAIN_ID;
    this.addresses = options.addresses ?? getAddresses(this.chainId);
    this.indexerPath = options.indexerPath ?? process.env.INDEXER_PATH ?? process.env.INDEXER_URL;
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

  async getPendingIntents(): Promise<Intent[]> {
    const store = await this.readIndexer();
    return (store?.pendingIntents ?? []).filter((i) => !i.resolved);
  }

  async getAuditTrail(): Promise<ProtocolEvent[]> {
    const store = await this.readIndexer();
    return store?.audit ?? [];
  }

  async proposeIntent(input: {
    agent: `0x${string}`;
    target: `0x${string}`;
    value: bigint;
    data?: Hex;
  }): Promise<{ intentId: string; verdict: Verdict }> {
    const wallet = this.requireWallet();
    const { request, result } = await this.publicClient.simulateContract({
      address: this.addresses.escalationRouter,
      abi: escalationRouterAbi,
      functionName: "propose",
      args: [input.agent, input.target, input.value, input.data ?? "0x"],
      account: wallet.account!,
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
    };
  }

  async resolveIntent(
    intentId: string,
    approved: boolean,
    _approver?: `0x${string}`,
  ): Promise<OnchainResolveResult> {
    const wallet = this.requireWallet();
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
    };
  }

  async getSessions(): Promise<SessionKey[]> {
    // TODO: Session-key module onchain.
    return [];
  }

  private requireWallet(): WalletClient {
    if (!this.walletClient?.account) {
      throw new Error("Onchain writes require an account (createOnchainClient({ account }))");
    }
    return this.walletClient;
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
