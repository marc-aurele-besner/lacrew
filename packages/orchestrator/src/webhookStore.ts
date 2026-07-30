/**
 * WebhookStore: pluggable persistence for webhook trigger records + their
 * delivery log. Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set,
 * else memory — same provider pattern as FlowStore / AuditStore.
 *
 * The memory store is not a degraded Postgres: `claimDelivery` is the
 * idempotency check, and in a single process a Map is exactly as correct as a
 * unique index. What memory cannot do is survive a restart or coordinate two
 * replicas, which is why the Postgres path exists at all.
 */

import {
  claimWebhookDelivery,
  createDb,
  deleteWebhookTrigger,
  getDatabaseUrl,
  getWebhookTrigger,
  insertWebhookDelivery,
  listWebhookTriggers,
  pruneWebhookDeliveries,
  recentWebhookDeliveries,
  settleWebhookDelivery,
  upsertWebhookTrigger,
  type DbHandle,
  type WebhookDeliveryRow,
  type WebhookTriggerRow,
} from "@lacrew/db";

export type { WebhookDeliveryRow, WebhookTriggerRow };

/** Delivery rows older than this are pruned; the ledger is not an archive. */
const DELIVERY_RETENTION_DAYS = 30;

export interface WebhookStore {
  readonly name: string;
  /** Whether rows outlive the process — decides if a secret must be sealed. */
  readonly durable: boolean;
  save(row: WebhookTriggerRow): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<WebhookTriggerRow[]>;
  /**
   * One trigger by id, read through rather than served from a cache.
   *
   * A durable deployment runs more than one replica against the same queue, so
   * the replica that mints a trigger and the one that receives its first
   * delivery are routinely different processes. Anything that resolves a
   * trigger only from the memory it hydrated at boot answers "no such trigger"
   * for every hook created since.
   */
  get(id: string): Promise<WebhookTriggerRow | null>;
  /** True when this delivery key is new for the trigger; false on a replay. */
  claimDelivery(row: {
    triggerId: string;
    deliveryKey: string;
    bytes?: number | null;
  }): Promise<boolean>;
  /** Record an outcome that establishes no idempotency (rejections). */
  logDelivery(row: Omit<WebhookDeliveryRow, "at">): Promise<void>;
  /** Attach the run outcome to an already-claimed delivery. */
  settleDelivery(row: {
    triggerId: string;
    deliveryKey: string;
    result: string;
    reason?: string | null;
    runId?: string | null;
  }): Promise<void>;
  recentDeliveries(
    limit: number,
    triggerId?: string,
  ): Promise<WebhookDeliveryRow[]>;
  /** Drop deliveries past the retention window (called on boot). */
  prune(): Promise<void>;
  close(): Promise<void>;
}

const DELIVERY_RING_MAX = 200;

export function createMemoryWebhookStore(): WebhookStore {
  const triggers = new Map<string, WebhookTriggerRow>();
  const ring: WebhookDeliveryRow[] = [];
  const claimed = new Set<string>();
  // JSON rather than a delimiter: delivery keys come from the producer and may
  // contain anything, so a separator could be forged to collide with another
  // trigger's claim.
  const key = (triggerId: string, deliveryKey: string) =>
    JSON.stringify([triggerId, deliveryKey]);

  const push = (row: WebhookDeliveryRow): void => {
    ring.push(row);
    if (ring.length > DELIVERY_RING_MAX)
      ring.splice(0, ring.length - DELIVERY_RING_MAX);
  };

  return {
    name: "memory",
    durable: false,
    save: async (row) => {
      triggers.set(row.id, { ...row });
    },
    remove: async (id) => {
      triggers.delete(id);
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i]!.triggerId === id) ring.splice(i, 1);
      }
    },
    list: async () => [...triggers.values()],
    get: async (id) => triggers.get(id) ?? null,
    claimDelivery: async (row) => {
      const k = key(row.triggerId, row.deliveryKey);
      if (claimed.has(k)) return false;
      claimed.add(k);
      push({
        triggerId: row.triggerId,
        deliveryKey: row.deliveryKey,
        result: "accepted",
        bytes: row.bytes ?? null,
        at: new Date().toISOString(),
      });
      return true;
    },
    logDelivery: async (row) => {
      push({ ...row, at: new Date().toISOString() });
    },
    settleDelivery: async (row) => {
      const found = ring.find(
        (d) =>
          d.triggerId === row.triggerId && d.deliveryKey === row.deliveryKey,
      );
      if (found) {
        found.result = row.result;
        found.reason = row.reason ?? null;
        found.runId = row.runId ?? null;
      }
    },
    recentDeliveries: async (limit, triggerId) =>
      [...ring]
        .reverse()
        .filter((d) => !triggerId || d.triggerId === triggerId)
        .slice(0, limit),
    // The ring is already bounded; nothing accumulates to prune.
    prune: async () => {},
    close: async () => {},
  };
}

export function createPgWebhookStore(url = getDatabaseUrl()): WebhookStore {
  let handle: DbHandle | undefined;
  const db = () => (handle ??= createDb(url));
  const warn = (op: string, err: unknown) =>
    console.error(`[@lacrew/orchestrator] webhook ${op} failed:`, err);

  return {
    name: "postgres",
    durable: true,
    save: async (row) => {
      // Unlike FlowStore, a failed save must reach the caller: a trigger whose
      // secret never landed would verify in this process and 404 in the next.
      await upsertWebhookTrigger(db(), row);
    },
    remove: async (id) => {
      await deleteWebhookTrigger(db(), id);
    },
    list: async () => {
      try {
        return await listWebhookTriggers(db());
      } catch (err) {
        warn("list", err);
        return [];
      }
    },
    // Unlike `list`, a failure here reaches the caller: an unreadable row must
    // not be answered as an absent trigger, which a producer would read as
    // "this hook was deleted" and stop retrying.
    get: async (id) => getWebhookTrigger(db(), id),
    claimDelivery: async (row) => {
      // A claim that cannot be recorded must not be treated as new: the
      // idempotency guarantee is the row, and enqueueing without one is how a
      // retried delivery runs a funded flow twice.
      return claimWebhookDelivery(db(), { ...row, result: "accepted" });
    },
    logDelivery: async (row) => {
      try {
        await insertWebhookDelivery(db(), row);
      } catch (err) {
        warn("delivery log", err);
      }
    },
    settleDelivery: async (row) => {
      try {
        await settleWebhookDelivery(db(), row);
      } catch (err) {
        warn("delivery settle", err);
      }
    },
    recentDeliveries: async (limit, triggerId) => {
      try {
        return await recentWebhookDeliveries(db(), limit, triggerId);
      } catch (err) {
        warn("delivery list", err);
        return [];
      }
    },
    prune: async () => {
      try {
        await pruneWebhookDeliveries(db(), DELIVERY_RETENTION_DAYS);
      } catch (err) {
        warn("delivery prune", err);
      }
    },
    close: async () => {
      await handle?.close();
      handle = undefined;
    },
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createWebhookStoreFromEnv(): WebhookStore {
  return getDatabaseUrl() ? createPgWebhookStore() : createMemoryWebhookStore();
}
