/**
 * Lightweight in-process event watcher for local demos.
 * TODO: Replace with Ponder + Postgres in Phase 1.
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

export type WatcherOptions = {
  rpcUrl: string;
  chainId?: number;
  storePath: string;
  routerAddress?: `0x${string}`;
};

export class EventWatcher {
  private readonly client: PublicClient;
  private readonly router: `0x${string}`;
  private readonly storePath: string;
  private store: IndexerStore;
  private unwatchers: Array<() => void> = [];

  constructor(options: WatcherOptions) {
    const chainId = options.chainId ?? 31337;
    const addresses = getAddresses(chainId);
    this.router = options.routerAddress ?? addresses.escalationRouter;
    this.storePath = options.storePath;
    this.store = loadStore(options.storePath);
    this.client = createPublicClient({ transport: http(options.rpcUrl) });
  }

  start(): void {
    const common = {
      address: this.router,
      onError: (err: Error) => {
        console.error("[@lacrew/indexer] watch error", err.message);
      },
    };

    this.unwatchers.push(
      this.client.watchEvent({
        ...common,
        event: intentCreated,
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
        ...common,
        event: intentEscalated,
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
        ...common,
        event: intentResolved,
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
              payload: { intentId, approved },
            });
            saveStore(this.storePath, this.store);
          }
        },
      }),
    );

    console.log(
      `[@lacrew/indexer] watching ${this.router} → ${this.storePath}`,
    );
  }

  stop(): void {
    for (const u of this.unwatchers) u();
    this.unwatchers = [];
  }

  getStore(): IndexerStore {
    return this.store;
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
