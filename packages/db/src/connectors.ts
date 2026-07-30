/** Query helpers for connector write policy (keeps Drizzle inside @lacrew/db). */

import { and, desc, eq } from "drizzle-orm";
import { connectorAsks, connectorWriteModes } from "./schema/connectors.js";
import type { DbHandle } from "./client.js";

export interface ConnectorModeRow {
  scopeKey: string;
  scope: Record<string, unknown>;
  route: string;
  mode: string;
  updatedAt: string;
}

export interface ConnectorAskRow {
  id: string;
  connector: string;
  route: string;
  method: string;
  path: string;
  fingerprint: string;
  args: Record<string, unknown>;
  principal: string;
  threadId: string;
  questionId: string;
  flowId?: string | null;
  runId?: string | null;
  status: string;
  outcome?: string | null;
  resume?: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
}

export async function upsertConnectorMode(handle: DbHandle, row: ConnectorModeRow): Promise<void> {
  const values = {
    scopeKey: row.scopeKey,
    scope: row.scope,
    route: row.route,
    mode: row.mode,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(connectorWriteModes)
    .values(values)
    .onConflictDoUpdate({
      target: [connectorWriteModes.scopeKey, connectorWriteModes.route],
      set: { mode: values.mode, scope: values.scope, updatedAt: values.updatedAt },
    });
}

export async function deleteConnectorMode(
  handle: DbHandle,
  scopeKey: string,
  route: string,
): Promise<void> {
  await handle.db
    .delete(connectorWriteModes)
    .where(and(eq(connectorWriteModes.scopeKey, scopeKey), eq(connectorWriteModes.route, route)));
}

export async function listConnectorModes(handle: DbHandle): Promise<ConnectorModeRow[]> {
  const rows = await handle.db.select().from(connectorWriteModes);
  return rows.map((row) => ({
    scopeKey: row.scopeKey,
    scope: row.scope ?? {},
    route: row.route,
    mode: row.mode,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function upsertConnectorAsk(handle: DbHandle, row: ConnectorAskRow): Promise<void> {
  const values = {
    id: row.id,
    connector: row.connector,
    route: row.route,
    method: row.method,
    path: row.path,
    fingerprint: row.fingerprint,
    args: row.args,
    principal: row.principal,
    threadId: row.threadId,
    questionId: row.questionId,
    flowId: row.flowId ?? null,
    runId: row.runId ?? null,
    status: row.status,
    outcome: row.outcome ?? null,
    resume: row.resume ?? null,
    createdAt: new Date(row.createdAt),
    expiresAt: new Date(row.expiresAt),
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
  };
  await handle.db
    .insert(connectorAsks)
    .values(values)
    .onConflictDoUpdate({ target: connectorAsks.id, set: values });
}

/**
 * Every ask, newest first, bounded.
 *
 * Resolved asks are loaded too, not only pending ones: the record of a spent
 * yes is what stops a replay of the same call after a restart, so dropping
 * them at hydration would reopen exactly the hole the fingerprint closes.
 */
export async function recentConnectorAsks(
  handle: DbHandle,
  limit: number,
): Promise<ConnectorAskRow[]> {
  const rows = await handle.db
    .select()
    .from(connectorAsks)
    .orderBy(desc(connectorAsks.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    connector: row.connector,
    route: row.route,
    method: row.method,
    path: row.path,
    fingerprint: row.fingerprint,
    args: row.args ?? {},
    principal: row.principal,
    threadId: row.threadId,
    questionId: row.questionId,
    flowId: row.flowId,
    runId: row.runId,
    status: row.status,
    outcome: row.outcome,
    resume: row.resume,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  }));
}
