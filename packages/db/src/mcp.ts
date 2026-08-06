/** Query helpers for the external MCP allowlist (keeps Drizzle inside @lacrew/db). */

import { and, eq } from "drizzle-orm";
import { externalMcpSecrets, externalMcpServers, externalMcpTools } from "./schema/mcp.js";
import type { DbHandle } from "./client.js";

export interface ExternalMcpToolRow {
  scopeKey: string;
  scope: Record<string, unknown>;
  server: string;
  tool: string;
  enabled: boolean;
  effect?: string | null;
  mode?: string | null;
  description?: string | null;
  discoveredAt?: string | null;
  updatedAt: string;
}

export async function upsertExternalMcpTool(
  handle: DbHandle,
  row: ExternalMcpToolRow,
): Promise<void> {
  const values = {
    scopeKey: row.scopeKey,
    scope: row.scope,
    server: row.server,
    tool: row.tool,
    enabled: row.enabled,
    effect: row.effect ?? null,
    mode: row.mode ?? null,
    description: row.description ?? null,
    discoveredAt: row.discoveredAt ? new Date(row.discoveredAt) : null,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(externalMcpTools)
    .values(values)
    .onConflictDoUpdate({
      target: [externalMcpTools.scopeKey, externalMcpTools.server, externalMcpTools.tool],
      set: {
        scope: values.scope,
        enabled: values.enabled,
        effect: values.effect,
        mode: values.mode,
        description: values.description,
        discoveredAt: values.discoveredAt,
        updatedAt: values.updatedAt,
      },
    });
}

export async function deleteExternalMcpTool(
  handle: DbHandle,
  scopeKey: string,
  server: string,
  tool: string,
): Promise<void> {
  await handle.db
    .delete(externalMcpTools)
    .where(
      and(
        eq(externalMcpTools.scopeKey, scopeKey),
        eq(externalMcpTools.server, server),
        eq(externalMcpTools.tool, tool),
      ),
    );
}

/**
 * The whole allowlist. Unbounded on purpose, unlike the event rings: a dropped
 * row is a tool that silently stops working, or — for a `*` deny — one that
 * silently starts.
 */
export async function listExternalMcpTools(handle: DbHandle): Promise<ExternalMcpToolRow[]> {
  const rows = await handle.db.select().from(externalMcpTools);
  return rows.map((row) => ({
    scopeKey: row.scopeKey,
    scope: row.scope ?? {},
    server: row.server,
    tool: row.tool,
    enabled: row.enabled,
    effect: row.effect,
    mode: row.mode,
    description: row.description,
    discoveredAt: row.discoveredAt ? row.discoveredAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export interface ExternalMcpServerRow {
  id: string;
  config: Record<string, unknown>;
  ownerKey?: string | null;
  updatedAt: string;
}

export async function upsertExternalMcpServer(
  handle: DbHandle,
  row: ExternalMcpServerRow,
): Promise<void> {
  const values = {
    id: row.id,
    config: row.config,
    ownerKey: row.ownerKey ?? null,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(externalMcpServers)
    .values(values)
    .onConflictDoUpdate({
      target: externalMcpServers.id,
      set: { config: values.config, ownerKey: values.ownerKey, updatedAt: values.updatedAt },
    });
}

export async function deleteExternalMcpServer(handle: DbHandle, id: string): Promise<void> {
  await handle.db.delete(externalMcpServers).where(eq(externalMcpServers.id, id));
}

/**
 * Every runtime-attached server. Read once at boot, before the first refresh
 * sweep, so a restart restores what was attached rather than quietly losing it.
 */
export async function listExternalMcpServers(handle: DbHandle): Promise<ExternalMcpServerRow[]> {
  const rows = await handle.db.select().from(externalMcpServers);
  return rows.map((row) => ({
    id: row.id,
    config: row.config ?? {},
    ownerKey: row.ownerKey,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export interface ExternalMcpSecretRow {
  ownerKey: string;
  ref: string;
  sealed: string;
  hint: string;
  updatedAt: string;
}

export async function upsertExternalMcpSecret(
  handle: DbHandle,
  row: ExternalMcpSecretRow,
): Promise<void> {
  const values = {
    ownerKey: row.ownerKey,
    ref: row.ref,
    sealed: row.sealed,
    hint: row.hint,
    updatedAt: new Date(row.updatedAt),
  };
  await handle.db
    .insert(externalMcpSecrets)
    .values(values)
    .onConflictDoUpdate({
      target: [externalMcpSecrets.ownerKey, externalMcpSecrets.ref],
      set: { sealed: values.sealed, hint: values.hint, updatedAt: values.updatedAt },
    });
}

export async function deleteExternalMcpSecret(
  handle: DbHandle,
  ownerKey: string,
  ref: string,
): Promise<void> {
  await handle.db
    .delete(externalMcpSecrets)
    .where(and(eq(externalMcpSecrets.ownerKey, ownerKey), eq(externalMcpSecrets.ref, ref)));
}

/**
 * Every sealed credential. Read once at boot, like the allowlist: a server
 * whose token did not come back would fail every call with
 * `mcp_missing_credential`, which reads as a rotation nobody performed.
 */
export async function listExternalMcpSecrets(handle: DbHandle): Promise<ExternalMcpSecretRow[]> {
  const rows = await handle.db.select().from(externalMcpSecrets);
  return rows.map((row) => ({
    ownerKey: row.ownerKey,
    ref: row.ref,
    sealed: row.sealed,
    hint: row.hint,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
