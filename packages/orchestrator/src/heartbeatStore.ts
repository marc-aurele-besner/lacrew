/**
 * HeartbeatStore: pluggable persistence for crew heartbeat configs + the tick
 * ledger. Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set, else
 * memory — same provider pattern as FlowStore / WebhookStore.
 *
 * As with webhook deliveries, the memory store is not a degraded Postgres:
 * `claimTick` is the coalescing check, and inside one process a Set is exactly
 * as correct as a unique index. What memory cannot do is survive a restart or
 * coordinate two replicas — which is the whole reason the Postgres path exists.
 */

import {
  claimCrewHeartbeatTick,
  createDb,
  deleteCrewHeartbeat,
  getCrewHeartbeat,
  getDatabaseUrl,
  listCrewHeartbeats,
  pruneCrewHeartbeatTicks,
  recentCrewHeartbeatTicks,
  settleCrewHeartbeatTick,
  upsertCrewHeartbeat,
  type CrewHeartbeatRow,
  type CrewHeartbeatTickRow,
  type DbHandle,
} from "@lacrew/db";
import type { CrewHeartbeat, InferenceUsage } from "@lacrew/flows";

export type { CrewHeartbeatTickRow };

/** One item's outcome inside a tick — the row a thread summary is derived from. */
export type HeartbeatItemResult = {
  kind: "flow" | "skill";
  id: string;
  principal: string;
  status: "ok" | "attention" | "failed" | "skipped";
  /** Flow run this item produced, when it got that far. */
  runId?: string;
  /** Stable snake_case reason, or the last line the run reported. */
  detail?: string;
};

export type HeartbeatTick = {
  crewId: string;
  windowKey: string;
  status: "running" | "ok" | "attention" | "failed" | "skipped";
  items: HeartbeatItemResult[];
  messageId?: string;
  /**
   * What the runs this tick started were metered at (F2.28 counters).
   *
   * Absent means unmeasured, not free: a process with no metering wired, or a
   * meter that could not be read. `unpricedCalls` inside it says the `$` figure
   * is a floor. Both distinctions are carried rather than flattened, because a
   * cost surface that renders "unknown" as `$0.00` is the one an operator stops
   * believing the first time a bill disagrees with it.
   */
  usage?: InferenceUsage;
  startedAt: string;
  finishedAt?: string;
};

export interface HeartbeatStore {
  readonly name: string;
  /** Whether rows outlive the process — decides if a claim coordinates replicas. */
  readonly durable: boolean;
  save(config: CrewHeartbeat): Promise<void>;
  remove(crewId: string): Promise<void>;
  list(): Promise<CrewHeartbeat[]>;
  /**
   * One heartbeat by crew id, read through rather than served from the boot
   * map. Replicas share a queue but not memory, so a heartbeat saved after a
   * worker booted is invisible to it — the same read-through webhook triggers
   * and flow definitions needed once dispatched work existed.
   */
  get(crewId: string): Promise<CrewHeartbeat | null>;
  /** True when this caller took the window; false when someone already has it. */
  claimTick(row: { crewId: string; windowKey: string }): Promise<boolean>;
  settleTick(row: {
    crewId: string;
    windowKey: string;
    status: HeartbeatTick["status"];
    items: HeartbeatItemResult[];
    messageId?: string;
    usage?: InferenceUsage;
  }): Promise<void>;
  recentTicks(limit: number, crewId?: string): Promise<HeartbeatTick[]>;
  /** Drop ticks past the retention window (called on boot). */
  prune(): Promise<void>;
  close(): Promise<void>;
}

const TICK_RING_MAX = 200;

/** Config → row. Checklist and quiet hours ride as opaque JSON both ways. */
function toRow(config: CrewHeartbeat): CrewHeartbeatRow {
  return {
    crewId: config.crewId,
    schedule: config.schedule,
    timezone: config.timezone ?? null,
    quietHours: (config.quietHours as unknown as Record<string, unknown>) ?? null,
    checklist: config.checklist as unknown[],
    principal: config.principal ?? null,
    model: config.model ?? null,
    notifyOnOk: config.notifyOnOk,
    stopOnError: config.stopOnError,
    enabled: config.enabled,
    updatedAt: config.updatedAt,
  };
}

function fromRow(row: CrewHeartbeatRow): CrewHeartbeat {
  return {
    crewId: row.crewId,
    schedule: row.schedule,
    ...(row.timezone ? { timezone: row.timezone } : {}),
    ...(row.quietHours
      ? { quietHours: row.quietHours as unknown as CrewHeartbeat["quietHours"] }
      : {}),
    checklist: (row.checklist ?? []) as CrewHeartbeat["checklist"],
    ...(row.principal ? { principal: row.principal } : {}),
    ...(row.model ? { model: row.model } : {}),
    notifyOnOk: row.notifyOnOk,
    stopOnError: row.stopOnError,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  };
}

function tickFromRow(row: CrewHeartbeatTickRow): HeartbeatTick {
  return {
    crewId: row.crewId,
    windowKey: row.windowKey,
    status: row.status as HeartbeatTick["status"],
    items: (row.items ?? []) as HeartbeatItemResult[],
    ...(row.messageId ? { messageId: row.messageId } : {}),
    ...(row.usage ? { usage: row.usage as unknown as InferenceUsage } : {}),
    startedAt: row.startedAt,
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
  };
}

export function createMemoryHeartbeatStore(): HeartbeatStore {
  const configs = new Map<string, CrewHeartbeat>();
  const ticks: HeartbeatTick[] = [];
  const claimed = new Set<string>();

  return {
    name: "memory",
    durable: false,
    save: async (config) => {
      configs.set(config.crewId, structuredClone(config));
    },
    remove: async (crewId) => {
      configs.delete(crewId);
    },
    list: async () => [...configs.values()],
    get: async (crewId) => configs.get(crewId) ?? null,
    claimTick: async (row) => {
      const key = JSON.stringify([row.crewId, row.windowKey]);
      if (claimed.has(key)) return false;
      claimed.add(key);
      ticks.push({
        crewId: row.crewId,
        windowKey: row.windowKey,
        status: "running",
        items: [],
        startedAt: new Date().toISOString(),
      });
      if (ticks.length > TICK_RING_MAX) ticks.splice(0, ticks.length - TICK_RING_MAX);
      return true;
    },
    settleTick: async (row) => {
      const found = ticks.find((t) => t.crewId === row.crewId && t.windowKey === row.windowKey);
      if (found) {
        found.status = row.status;
        found.items = row.items;
        if (row.messageId) found.messageId = row.messageId;
        if (row.usage) found.usage = row.usage;
        found.finishedAt = new Date().toISOString();
      }
    },
    recentTicks: async (limit, crewId) =>
      [...ticks]
        .reverse()
        .filter((t) => !crewId || t.crewId === crewId)
        .slice(0, limit),
    // The ring is already bounded; nothing accumulates to prune.
    prune: async () => {},
    close: async () => {},
  };
}

export function createPgHeartbeatStore(url = getDatabaseUrl()): HeartbeatStore {
  let handle: DbHandle | undefined;
  const db = () => (handle ??= createDb(url));
  const warn = (op: string, err: unknown) =>
    console.error(`[@lacrew/orchestrator] heartbeat ${op} failed:`, err);

  return {
    name: "postgres",
    durable: true,
    // Reaches the caller, unlike the reads below: a heartbeat whose save never
    // landed would fire in this process and be absent from the next, and the
    // operator would have been told it was stored.
    save: async (config) => {
      await upsertCrewHeartbeat(db(), toRow(config));
    },
    remove: async (crewId) => {
      await deleteCrewHeartbeat(db(), crewId);
    },
    list: async () => {
      try {
        return (await listCrewHeartbeats(db())).map(fromRow);
      } catch (err) {
        warn("list", err);
        return [];
      }
    },
    // Rethrows for the reason `get` on a webhook trigger does: an unreadable
    // row must not be answered as an absent heartbeat, which a caller would
    // read as "this crew has none" and quietly stop beating.
    get: async (crewId) => {
      const row = await getCrewHeartbeat(db(), crewId);
      return row ? fromRow(row) : null;
    },
    claimTick: async (row) => {
      // A claim that cannot be recorded must not be treated as taken: the
      // exactly-once guarantee *is* the row, and working through a checklist
      // without one is how a crew runs its list twice in the same minute.
      return claimCrewHeartbeatTick(db(), row);
    },
    settleTick: async (row) => {
      try {
        await settleCrewHeartbeatTick(db(), {
          ...row,
          usage: (row.usage as unknown as Record<string, unknown>) ?? null,
        });
      } catch (err) {
        warn("tick settle", err);
      }
    },
    recentTicks: async (limit, crewId) => {
      try {
        return (await recentCrewHeartbeatTicks(db(), limit, crewId)).map(tickFromRow);
      } catch (err) {
        warn("ticks list", err);
        return [];
      }
    },
    prune: async () => {
      try {
        await pruneCrewHeartbeatTicks(db());
      } catch (err) {
        warn("tick prune", err);
      }
    },
    close: async () => {
      await handle?.close();
      handle = undefined;
    },
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createHeartbeatStoreFromEnv(): HeartbeatStore {
  return getDatabaseUrl() ? createPgHeartbeatStore() : createMemoryHeartbeatStore();
}
