/**
 * Lightweight in-process event watcher for local demos.
 * Watches escalation + governance + treasury + session events into a JSON store.
 * TODO: Replace with Ponder + Neon/Docker Postgres in Phase 1.
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import {
  getAddresses,
  escalationRouterAbi,
  type ChainAddresses,
  type Intent,
  type ProtocolEvent,
} from "@lacrew/core";
import { loadStore, saveStore, type IndexerStore } from "./store.js";

const intentCreated = parseAbiItem(
  "event IntentCreated(uint256 indexed intentId, address indexed agent, address awaitingApprover)",
);
const intentEscalated = parseAbiItem(
  "event IntentEscalated(uint256 indexed intentId, address indexed from, address indexed to)",
);
const intentResolved = parseAbiItem(
  "event IntentResolved(uint256 indexed intentId, bool approved)",
);
const actionExecuted = parseAbiItem(
  "event ActionExecuted(address indexed agent, address indexed target, uint256 value, bool callOk)",
);
const proposalCreated = parseAbiItem(
  "event ProposalCreated(uint256 indexed proposalId, address indexed proposer, uint8 tier, address target, bytes32 actionHash)",
);
const proposalExecuted = parseAbiItem(
  "event ProposalExecuted(uint256 indexed proposalId)",
);
const proposalVetoed = parseAbiItem(
  "event ProposalVetoed(uint256 indexed proposalId, address indexed vetoer)",
);
const allowanceStreamed = parseAbiItem(
  "event AllowanceStreamed(address indexed node, uint256 amount, uint64 epoch)",
);
const sessionIssued = parseAbiItem(
  "event SessionIssued(uint256 indexed sessionId, address indexed agent, address indexed key, uint64 expiresAt, bytes32 scopesHash)",
);
const sessionRevoked = parseAbiItem(
  "event SessionRevoked(uint256 indexed sessionId, address indexed by)",
);

export type WatcherOptions = {
  rpcUrl: string;
  chainId?: number;
  storePath: string;
  routerAddress?: `0x${string}`;
};

type WatchCommon = {
  onError: (err: Error) => void;
};

export class EventWatcher {
  private readonly client: PublicClient;
  private readonly addresses: ChainAddresses;
  private readonly router: `0x${string}`;
  private readonly storePath: string;
  private store: IndexerStore;
  private unwatchers: Array<() => void> = [];
  private lastErrorAt = 0;

  constructor(options: WatcherOptions) {
    const chainId = options.chainId ?? 31337;
    this.addresses = getAddresses(chainId);
    this.router = options.routerAddress ?? this.addresses.escalationRouter;
    this.storePath = options.storePath;
    this.store = loadStore(options.storePath);
    this.client = createPublicClient({ transport: http(options.rpcUrl) });
  }

  start(): void {
    const common: WatchCommon = {
      onError: (err: Error) => {
        const now = Date.now();
        if (now - this.lastErrorAt < 15_000) return;
        this.lastErrorAt = now;
        console.error("[@lacrew/indexer] watch error:", err.message.split("\n")[0]);
      },
    };

    this.watchRouter(common);
    this.watchGovernance(common);
    this.watchTreasury(common);
    this.watchSessions(common);

    console.log(
      `[@lacrew/indexer] watching router/gov/treasury/sessions → ${this.storePath}`,
    );
  }

  stop(): void {
    for (const u of this.unwatchers) u();
    this.unwatchers = [];
  }

  getStore(): IndexerStore {
    return this.store;
  }

  private watchRouter(common: WatchCommon): void {
    this.unwatchers.push(
      this.client.watchEvent({
        address: this.router,
        event: intentCreated,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            const intentId = (log.args.intentId as bigint).toString();
            const agent = log.args.agent as `0x${string}`;
            const awaiting = log.args.awaitingApprover as `0x${string}`;
            void this.upsertFromChain(BigInt(intentId), agent, awaiting);
            this.pushAudit({
              type: "IntentCreated",
              at: new Date().toISOString(),
              payload: { intentId, agent, awaitingApprover: awaiting },
            });
          }
        },
      }),
    );

    this.unwatchers.push(
      this.client.watchEvent({
        address: this.router,
        event: intentEscalated,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            const intentId = (log.args.intentId as bigint).toString();
            const from = log.args.from as `0x${string}`;
            const to = log.args.to as `0x${string}`;
            const intent = this.store.pendingIntents.find((i) => i.id === intentId);
            if (intent) intent.awaitingApprover = to;
            this.pushAudit({
              type: "IntentEscalated",
              at: new Date().toISOString(),
              payload: { intentId, from, to },
            });
            saveStore(this.storePath, this.store);
          }
        },
      }),
    );

    this.unwatchers.push(
      this.client.watchEvent({
        address: this.router,
        event: intentResolved,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            const intentId = (log.args.intentId as bigint).toString();
            const approved = Boolean(log.args.approved);
            const intent = this.store.pendingIntents.find((i) => i.id === intentId);
            if (intent) {
              intent.resolved = true;
              intent.approved = approved;
              intent.verdict = approved ? "ALLOW" : "DENY";
            }
            this.pushAudit({
              type: "IntentResolved",
              at: new Date().toISOString(),
              payload: { intentId, approved, txHash: log.transactionHash },
            });
            saveStore(this.storePath, this.store);
          }
        },
      }),
    );

    this.unwatchers.push(
      this.client.watchEvent({
        address: this.router,
        event: actionExecuted,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            this.pushAudit({
              type: "ActionExecuted",
              at: new Date().toISOString(),
              payload: {
                agent: log.args.agent as string,
                target: log.args.target as string,
                value: (log.args.value as bigint).toString(),
                callOk: Boolean(log.args.callOk),
                txHash: log.transactionHash,
              },
            });
          }
        },
      }),
    );
  }

  private watchGovernance(common: WatchCommon): void {
    const gov = this.addresses.governanceModule;
    if (!gov || gov.endsWith("0000")) return;

    this.unwatchers.push(
      this.client.watchEvent({
        address: gov,
        event: proposalCreated,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            this.pushAudit({
              type: "ProposalCreated",
              at: new Date().toISOString(),
              payload: {
                proposalId: (log.args.proposalId as bigint).toString(),
                proposer: log.args.proposer as string,
                tier: Number(log.args.tier),
                target: log.args.target as string,
                actionHash: log.args.actionHash as string,
                txHash: log.transactionHash,
              },
            });
          }
        },
      }),
    );

    this.unwatchers.push(
      this.client.watchEvent({
        address: gov,
        event: proposalExecuted,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            this.pushAudit({
              type: "ProposalExecuted",
              at: new Date().toISOString(),
              payload: {
                proposalId: (log.args.proposalId as bigint).toString(),
                txHash: log.transactionHash,
              },
            });
          }
        },
      }),
    );

    this.unwatchers.push(
      this.client.watchEvent({
        address: gov,
        event: proposalVetoed,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            this.pushAudit({
              type: "ProposalVetoed",
              at: new Date().toISOString(),
              payload: {
                proposalId: (log.args.proposalId as bigint).toString(),
                vetoer: log.args.vetoer as string,
                txHash: log.transactionHash,
              },
            });
          }
        },
      }),
    );
  }

  private watchTreasury(common: WatchCommon): void {
    const treasury = this.addresses.treasury;
    if (!treasury || treasury.endsWith("0000")) return;

    this.unwatchers.push(
      this.client.watchEvent({
        address: treasury,
        event: allowanceStreamed,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            this.pushAudit({
              type: "AllowanceStreamed",
              at: new Date().toISOString(),
              payload: {
                node: log.args.node as string,
                amount: (log.args.amount as bigint).toString(),
                epoch: Number(log.args.epoch),
                txHash: log.transactionHash,
              },
            });
          }
        },
      }),
    );
  }

  private watchSessions(common: WatchCommon): void {
    const sessions = this.addresses.sessionRegistry;
    if (!sessions) return;

    this.unwatchers.push(
      this.client.watchEvent({
        address: sessions,
        event: sessionIssued,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            this.pushAudit({
              type: "SessionIssued",
              at: new Date().toISOString(),
              payload: {
                keyId: (log.args.sessionId as bigint).toString(),
                agent: log.args.agent as string,
                keyAddress: log.args.key as string,
                expiresAt: Number(log.args.expiresAt) * 1000,
                txHash: log.transactionHash,
              },
            });
          }
        },
      }),
    );

    this.unwatchers.push(
      this.client.watchEvent({
        address: sessions,
        event: sessionRevoked,
        ...common,
        onLogs: (logs) => {
          for (const log of logs) {
            this.pushAudit({
              type: "SessionRevoked",
              at: new Date().toISOString(),
              payload: {
                keyId: (log.args.sessionId as bigint).toString(),
                by: log.args.by as string,
                txHash: log.transactionHash,
              },
            });
          }
        },
      }),
    );
  }

  private pushAudit(event: ProtocolEvent): void {
    this.store.audit.push(event);
    saveStore(this.storePath, this.store);
  }

  private async upsertFromChain(
    id: bigint,
    agent: `0x${string}`,
    awaiting: `0x${string}`,
  ): Promise<void> {
    let target = "0x0000000000000000000000000000000000000000" as `0x${string}`;
    let value = 0n;
    let data = "0x" as Hex;
    try {
      const row = (await this.client.readContract({
        address: this.router,
        abi: escalationRouterAbi,
        functionName: "intents",
        args: [id],
      })) as unknown as readonly [
        `0x${string}`,
        `0x${string}`,
        bigint,
        Hex,
        `0x${string}`,
        boolean,
        boolean,
      ];
      target = row[1];
      value = row[2];
      data = row[3];
    } catch {
      // keep defaults
    }

    const intent: Intent = {
      id: id.toString(),
      agent,
      target,
      value,
      data,
      awaitingApprover: awaiting,
      resolved: false,
      approved: null,
      verdict: "ESCALATE",
    };
    const idx = this.store.pendingIntents.findIndex((i) => i.id === intent.id);
    if (idx >= 0) this.store.pendingIntents[idx] = intent;
    else this.store.pendingIntents.push(intent);
    saveStore(this.storePath, this.store);
  }
}
