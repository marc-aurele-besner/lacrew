/** Query helpers for webhook flow triggers (keeps Drizzle inside @lacrew/db). */

import { and, desc, eq, sql } from "drizzle-orm";
import { webhookDeliveries, webhookTriggers } from "./schema/webhooks.js";
import type { DbHandle } from "./client.js";

export interface WebhookTriggerRow {
  id: string;
  flowId: string;
  principal?: string | null;
  scheme: string;
  /** Sealed envelope JSON — callers unseal, this layer never sees cleartext. */
  secretSealed: string;
  secretVersion: number;
  enabled: boolean;
  inputMap?: Record<string, unknown> | null;
  events?: string[] | null;
  config?: Record<string, unknown> | null;
  description?: string | null;
}

export interface WebhookDeliveryRow {
  triggerId: string;
  deliveryKey: string;
  result: string;
  reason?: string | null;
  runId?: string | null;
  bytes?: number | null;
  at: string;
}

export async function upsertWebhookTrigger(
  handle: DbHandle,
  row: WebhookTriggerRow,
): Promise<void> {
  const values = {
    id: row.id,
    flowId: row.flowId,
    principal: row.principal ?? null,
    scheme: row.scheme,
    secretSealed: row.secretSealed,
    secretVersion: row.secretVersion,
    enabled: row.enabled,
    inputMap: row.inputMap ?? null,
    events: row.events ?? null,
    config: row.config ?? null,
    description: row.description ?? null,
    updatedAt: new Date(),
  };
  await handle.db
    .insert(webhookTriggers)
    .values(values)
    .onConflictDoUpdate({ target: webhookTriggers.id, set: values });
}

export async function getWebhookTrigger(
  handle: DbHandle,
  id: string,
): Promise<WebhookTriggerRow | null> {
  const rows = await handle.db
    .select()
    .from(webhookTriggers)
    .where(eq(webhookTriggers.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    flowId: row.flowId,
    principal: row.principal,
    scheme: row.scheme,
    secretSealed: row.secretSealed,
    secretVersion: row.secretVersion,
    enabled: row.enabled,
    inputMap: row.inputMap,
    events: row.events,
    config: row.config,
    description: row.description,
  };
}

export async function deleteWebhookTrigger(handle: DbHandle, id: string): Promise<void> {
  await handle.db.delete(webhookTriggers).where(eq(webhookTriggers.id, id));
  await handle.db.delete(webhookDeliveries).where(eq(webhookDeliveries.triggerId, id));
}

export async function listWebhookTriggers(handle: DbHandle): Promise<WebhookTriggerRow[]> {
  const rows = await handle.db
    .select()
    .from(webhookTriggers)
    .orderBy(desc(webhookTriggers.createdAt));
  return rows.map((row) => ({
    id: row.id,
    flowId: row.flowId,
    principal: row.principal,
    scheme: row.scheme,
    secretSealed: row.secretSealed,
    secretVersion: row.secretVersion,
    enabled: row.enabled,
    inputMap: row.inputMap,
    events: row.events,
    config: row.config,
    description: row.description,
  }));
}

/**
 * Claim a delivery key, returning false when this trigger already saw it.
 *
 * The unique index does the work: two replicas handed the same delivery both
 * run this insert, exactly one row lands, and only that caller is told to
 * enqueue. Doing the check as a prior SELECT would leave the race open.
 */
export async function claimWebhookDelivery(
  handle: DbHandle,
  row: Pick<WebhookDeliveryRow, "triggerId" | "deliveryKey" | "result"> & {
    bytes?: number | null;
  },
): Promise<boolean> {
  const inserted = await handle.db
    .insert(webhookDeliveries)
    .values({
      triggerId: row.triggerId,
      deliveryKey: row.deliveryKey,
      result: row.result,
      bytes: row.bytes ?? null,
      at: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  return inserted.length > 0;
}

/** Record a delivery outcome that carries no idempotency guarantee (rejections). */
export async function insertWebhookDelivery(
  handle: DbHandle,
  row: Omit<WebhookDeliveryRow, "at"> & { at?: string },
): Promise<void> {
  await handle.db
    .insert(webhookDeliveries)
    .values({
      triggerId: row.triggerId,
      deliveryKey: row.deliveryKey,
      result: row.result,
      reason: row.reason ?? null,
      runId: row.runId ?? null,
      bytes: row.bytes ?? null,
      at: row.at ? new Date(row.at) : new Date(),
    })
    .onConflictDoNothing();
}

/** Update a claimed delivery once its run is known. */
export async function settleWebhookDelivery(
  handle: DbHandle,
  row: Pick<WebhookDeliveryRow, "triggerId" | "deliveryKey" | "result"> & {
    reason?: string | null;
    runId?: string | null;
  },
): Promise<void> {
  await handle.db
    .update(webhookDeliveries)
    .set({
      result: row.result,
      reason: row.reason ?? null,
      runId: row.runId ?? null,
    })
    .where(
      and(
        eq(webhookDeliveries.triggerId, row.triggerId),
        eq(webhookDeliveries.deliveryKey, row.deliveryKey),
      ),
    );
}

/** Most recent deliveries, newest → oldest; all triggers when `triggerId` is omitted. */
export async function recentWebhookDeliveries(
  handle: DbHandle,
  limit: number,
  triggerId?: string,
): Promise<WebhookDeliveryRow[]> {
  const base = handle.db.select().from(webhookDeliveries);
  const rows = await (triggerId ? base.where(eq(webhookDeliveries.triggerId, triggerId)) : base)
    .orderBy(desc(webhookDeliveries.at), desc(webhookDeliveries.id))
    .limit(limit);
  return rows.map((row) => ({
    triggerId: row.triggerId,
    deliveryKey: row.deliveryKey,
    result: row.result,
    reason: row.reason,
    runId: row.runId,
    bytes: row.bytes,
    at: row.at.toISOString(),
  }));
}

/**
 * Drop delivery rows older than `days`, so the idempotency ledger does not grow
 * without bound. Replay protection past the retention window is the signature
 * timestamp's job, not this table's.
 */
export async function pruneWebhookDeliveries(handle: DbHandle, days: number): Promise<void> {
  await handle.db
    .delete(webhookDeliveries)
    .where(sql`${webhookDeliveries.at} < now() - make_interval(days => ${days})`);
}
