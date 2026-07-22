/**
 * Lightweight in-process event watcher for local demos.
 * Streams escalation + governance + treasury + session events into a JSON
 * store and out to every configured EventSink — Postgres by default
 * (orchestrator_audit_events — the stable consumer schema, F1.11) with
 * (tx_hash, log_index) dedup so backfills are idempotent.
 * TODO: Replace the watch loop with Ponder once multi-chain reorg handling
 * matters. That swaps the event *source*; sinks are already pluggable.
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type AbiEvent,
  type Hex,
  type Log,
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
import { createEventSinksFromEnv, writeToSinks, type EventSink } from "./sinks/index.js";

const routerEvents = [
  parseAbiItem(
    "event IntentCreated(uint256 indexed intentId, address indexed agent, address awaitingApprover)",
  ),
  parseAbiItem(
    "event IntentEscalated(uint256 indexed intentId, address indexed from, address indexed to)",
  ),
  parseAbiItem("event IntentResolved(uint256 indexed intentId, bool approved)"),
  parseAbiItem(
    "event ActionExecuted(address indexed agent, address indexed target, uint256 value, bool callOk)",
  ),
];
const governanceEvents = [
  parseAbiItem(
    "event ProposalCreated(uint256 indexed proposalId, address indexed proposer, uint8 tier, address target, bytes32 actionHash)",
  ),
  parseAbiItem(
    "event Voted(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight)",
  ),
  parseAbiItem("event ProposalExecuted(uint256 indexed proposalId)"),
  parseAbiItem("event ProposalVetoed(uint256 indexed proposalId, address indexed vetoer)"),
  parseAbiItem("event ProposalDefeated(uint256 indexed proposalId)"),
];
const treasuryEvents = [
  parseAbiItem("event AllowanceStreamed(address indexed node, uint256 amount, uint64 epoch)"),
];
const sessionEvents = [
  parseAbiItem(
    "event SessionIssued(uint256 indexed sessionId, address indexed agent, address indexed key, uint64 expiresAt, bytes32 scopesHash, uint256 maxValue, address allowedTarget)",
  ),
  parseAbiItem("event SessionRevoked(uint256 indexed sessionId, address indexed by)"),
];

type DecodedLog = Log & { eventName?: string; args?: Record<string, unknown> };

/** Map a decoded contract log to the ProtocolEvent shape consumers read. */
export function logToProtocolEvent(
  eventName: string,
  args: Record<string, unknown>,
  txHash: string | null,
  at: string,
): ProtocolEvent | null {
  switch (eventName) {
    case "IntentCreated":
      return {
        type: "IntentCreated",
        at,
        payload: {
          intentId: String(args.intentId),
          agent: args.agent as string,
          awaitingApprover: args.awaitingApprover as string,
        },
      };
    case "IntentEscalated":
      return {
        type: "IntentEscalated",
        at,
        payload: {
          intentId: String(args.intentId),
          from: args.from as string,
          to: args.to as string,
        },
      };
    case "IntentResolved":
      return {
        type: "IntentResolved",
        at,
        payload: { intentId: String(args.intentId), approved: Boolean(args.approved), txHash },
      };
    case "ActionExecuted":
      return {
        type: "ActionExecuted",
        at,
        payload: {
          agent: args.agent as string,
          target: args.target as string,
          value: String(args.value),
          callOk: Boolean(args.callOk),
          txHash,
        },
      };
    case "ProposalCreated":
      return {
        type: "ProposalCreated",
        at,
        payload: {
          proposalId: String(args.proposalId),
          proposer: args.proposer as string,
          tier: Number(args.tier),
          target: args.target as string,
          actionHash: args.actionHash as string,
          txHash,
        },
      };
    // The contract emits `Voted`; consumers read it as ProposalVoted, the same
    // shape the orchestrator records when it casts a vote itself.
    case "Voted":
      return {
        type: "ProposalVoted",
        at,
        payload: {
          proposalId: String(args.proposalId),
          voter: args.voter as string,
          support: Boolean(args.support),
          weight: String(args.weight),
          txHash,
        },
      };
    case "ProposalExecuted":
      return {
        type: "ProposalExecuted",
        at,
        payload: { proposalId: String(args.proposalId), txHash },
      };
    case "ProposalDefeated":
      return {
        type: "ProposalDefeated",
        at,
        payload: { proposalId: String(args.proposalId), txHash },
      };
    case "ProposalVetoed":
      return {
        type: "ProposalVetoed",
        at,
        payload: { proposalId: String(args.proposalId), vetoer: args.vetoer as string, txHash },
      };
    case "AllowanceStreamed":
      return {
        type: "AllowanceStreamed",
        at,
        payload: {
          node: args.node as string,
          amount: String(args.amount),
          epoch: Number(args.epoch),
          txHash,
        },
      };
    case "SessionIssued":
      return {
        type: "SessionIssued",
        at,
        payload: {
          keyId: String(args.sessionId),
          agent: args.agent as string,
          keyAddress: args.key as string,
          expiresAt: Number(args.expiresAt) * 1000,
          maxValue: args.maxValue === undefined ? undefined : String(args.maxValue),
          allowedTarget: args.allowedTarget as string | undefined,
          txHash,
        },
      };
    case "SessionRevoked":
      return {
        type: "SessionRevoked",
        at,
        payload: { keyId: String(args.sessionId), by: args.by as string, txHash },
      };
    default:
      return null;
  }
}

export type WatcherOptions = {
  rpcUrl: string;
  chainId?: number;
  storePath: string;
  routerAddress?: `0x${string}`;
  /** Durable targets for decoded events; defaults to Postgres when configured. */
  sinks?: EventSink[];
};

export class EventWatcher {
  private readonly client: PublicClient;
  private readonly addresses: ChainAddresses;
  private readonly router: `0x${string}`;
  private readonly storePath: string;
  private store: IndexerStore;
  private unwatchers: Array<() => void> = [];
  private lastErrorAt = 0;
  private readonly sinks: EventSink[];
  private readonly blockTimes = new Map<bigint, string>();

  constructor(options: WatcherOptions) {
    const chainId = options.chainId ?? 31337;
    this.addresses = getAddresses(chainId);
    this.router = options.routerAddress ?? this.addresses.escalationRouter;
    this.storePath = options.storePath;
    this.store = loadStore(options.storePath);
    this.client = createPublicClient({ transport: http(options.rpcUrl) });
    this.sinks = options.sinks ?? createEventSinksFromEnv();
  }

  /** Contract → decoded-event sets this watcher covers. */
  private contracts(): Array<{ address: `0x${string}`; events: AbiEvent[] }> {
    const list: Array<{ address: `0x${string}`; events: AbiEvent[] }> = [
      { address: this.router, events: routerEvents },
    ];
    const gov = this.addresses.governanceModule;
    if (gov && !gov.endsWith("0000")) list.push({ address: gov, events: governanceEvents });
    const treasury = this.addresses.treasury;
    if (treasury && !treasury.endsWith("0000"))
      list.push({ address: treasury, events: treasuryEvents });
    const sessions = this.addresses.sessionRegistry;
    if (sessions) list.push({ address: sessions, events: sessionEvents });
    return list;
  }

  /**
   * Index historical logs from `fromBlock` to latest. Idempotent: Postgres
   * dedups on (tx_hash, log_index); the JSON audit is rewritten from scratch
   * only when currently empty (otherwise left to live watch).
   */
  async backfill(fromBlock = 0n): Promise<number> {
    const collected: DecodedLog[] = [];
    for (const { address, events } of this.contracts()) {
      const logs = await this.client.getLogs({
        address,
        events,
        fromBlock,
        toBlock: "latest",
      });
      collected.push(...(logs as DecodedLog[]));
    }
    collected.sort((a, b) => {
      const byBlock = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
      if (byBlock !== 0) return byBlock;
      return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });

    const skipJsonAudit = this.store.audit.length > 0;
    for (const log of collected) {
      await this.processLog(log, { skipJsonAudit });
    }
    return collected.length;
  }

  start(): void {
    const onError = (err: Error) => {
      const now = Date.now();
      if (now - this.lastErrorAt < 15_000) return;
      this.lastErrorAt = now;
      console.error("[@lacrew/indexer] watch error:", err.message.split("\n")[0]);
    };

    for (const { address, events } of this.contracts()) {
      this.unwatchers.push(
        this.client.watchEvent({
          address,
          events,
          onError,
          onLogs: (logs) => {
            for (const log of logs as DecodedLog[]) void this.processLog(log);
          },
        }),
      );
    }

    console.log(
      `[@lacrew/indexer] watching router/gov/treasury/sessions → ${this.storePath}` +
        (this.sinks.length > 0 ? ` + ${this.sinks.map((s) => s.name).join(", ")}` : ""),
    );
  }

  /** Unsubscribe and release sink handles (the pg pool holds the process open). */
  async stop(): Promise<void> {
    for (const u of this.unwatchers) u();
    this.unwatchers = [];
    for (const sink of this.sinks) await sink.close();
  }

  getStore(): IndexerStore {
    return this.store;
  }

  /** Decode, apply store side effects, and fan out to JSON + Postgres sinks. */
  private async processLog(
    log: DecodedLog,
    opts: { skipJsonAudit?: boolean } = {},
  ): Promise<void> {
    const eventName = log.eventName;
    const args = log.args;
    if (!eventName || !args) return;

    const { at, source: atSource } = await this.blockTime(log.blockNumber);
    const event = logToProtocolEvent(eventName, args, log.transactionHash, at);
    if (!event) return;
    event.atSource = atSource;

    if (eventName === "IntentCreated") {
      await this.upsertFromChain(
        BigInt(String(args.intentId)),
        args.agent as `0x${string}`,
        args.awaitingApprover as `0x${string}`,
      );
    } else if (eventName === "IntentEscalated") {
      const intent = this.store.pendingIntents.find((i) => i.id === String(args.intentId));
      if (intent) intent.awaitingApprover = args.to as `0x${string}`;
    } else if (eventName === "IntentResolved") {
      const intent = this.store.pendingIntents.find((i) => i.id === String(args.intentId));
      if (intent) {
        intent.resolved = true;
        intent.approved = Boolean(args.approved);
        intent.verdict = args.approved ? "ALLOW" : "DENY";
      }
    }

    if (!opts.skipJsonAudit) this.store.audit.push(event);
    saveStore(this.storePath, this.store);

    await writeToSinks(this.sinks, {
      event,
      txHash: log.transactionHash ?? null,
      logIndex: log.logIndex ?? null,
    });
  }

  /**
   * Block timestamp → ISO, cached per block.
   *
   * Falls back to ingestion time when the block cannot be read, and says so:
   * ordering still needs a timestamp, but the audit trail must not present
   * "when we noticed" as "when it happened".
   */
  private async blockTime(
    blockNumber: bigint | null,
  ): Promise<{ at: string; source: "block" | "ingest" }> {
    if (blockNumber == null) return { at: new Date().toISOString(), source: "ingest" };
    const cached = this.blockTimes.get(blockNumber);
    if (cached) return { at: cached, source: "block" };
    try {
      const block = await this.client.getBlock({ blockNumber });
      const iso = new Date(Number(block.timestamp) * 1000).toISOString();
      this.blockTimes.set(blockNumber, iso);
      return { at: iso, source: "block" };
    } catch {
      return { at: new Date().toISOString(), source: "ingest" };
    }
  }

  private async upsertFromChain(
    id: bigint,
    agent: `0x${string}`,
    awaiting: `0x${string}`,
  ): Promise<void> {
    let target: `0x${string}` | undefined;
    let value: bigint | undefined;
    let data: Hex | undefined;
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
      // Left undefined. The zeros this used to fall back to were not a
      // degraded read, they were a different spend request: an approver saw
      // "0 USDC → 0x0000…0000" and had no way to tell it from a real one.
    }

    const unreadable = target === undefined || value === undefined || data === undefined;
    const intent: Intent = {
      id: id.toString(),
      agent,
      // Still zeros on the unreadable path, because the field is typed as an
      // address and something must be there — but `unreadable` travels with
      // them, so a consumer can say "could not read" instead of rendering a
      // spend of nothing to nobody.
      target: target ?? "0x0000000000000000000000000000000000000000",
      value: value ?? 0n,
      data: data ?? "0x",
      awaitingApprover: awaiting,
      resolved: false,
      approved: null,
      verdict: "ESCALATE",
      ...(unreadable ? { unreadable: true } : {}),
    };
    const idx = this.store.pendingIntents.findIndex((i) => i.id === intent.id);
    if (idx >= 0) this.store.pendingIntents[idx] = intent;
    else this.store.pendingIntents.push(intent);
    saveStore(this.storePath, this.store);
  }
}
