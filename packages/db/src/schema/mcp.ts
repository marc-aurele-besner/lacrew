import { index, pgTable, text, boolean, jsonb, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * External MCP tool allowlist (F2.30): which third-party tool an operator has
 * admitted, at which scope, and in which write mode.
 *
 * The rows *are* the allowlist. A tool with no row here is refused — including
 * one that showed up on the server after registration — so this table failing
 * to load must fail closed rather than fall back to "everything the server
 * offers", and the orchestrator treats a read error that way.
 *
 * No credential lands here. A server's endpoint and the env vars it reads live
 * in configuration; what is stored is the operator's decision about a tool.
 */
export const externalMcpTools = pgTable(
  "orchestrator_external_mcp_tools",
  {
    /** `workspace`, `crew:<address>`, or `agent:<address>`. */
    scopeKey: text("scope_key").notNull(),
    scope: jsonb("scope").notNull().$type<Record<string, unknown>>(),
    /** Server id from configuration — the `mcp__<server>__<tool>` namespace. */
    server: text("server").notNull(),
    /** A tool name, or `*` (which may only narrow, never admit). */
    tool: text("tool").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** `read` | `write`; set at workspace scope only. Null reads as `write`. */
    effect: text("effect"),
    /** `auto` | `ask` | `deny` on a write. Null inherits. */
    mode: text("mode"),
    /** The server's own description, for the operator surface. */
    description: text("description"),
    /** When discovery last saw this tool on the server. */
    discoveredAt: timestamp("discovered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("external_mcp_tools_scope_server_tool").on(table.scopeKey, table.server, table.tool),
    index("external_mcp_tools_server_idx").on(table.server),
  ],
);

/**
 * External MCP servers attached at runtime (F2.30).
 *
 * A server named in `LACREW_MCP_SERVERS` is not here — env is its source of
 * truth and a copy would go stale the moment an operator edits it. These are
 * the ones an API call attached, which have nowhere else to live and would
 * otherwise vanish on the next restart.
 *
 * **No credential lands here either.** The config carries env var *names* the
 * runtime reads at call time, exactly as a boot config does, so a row is safe
 * to store, read back and log. What makes the row sensitive is `owner_key`: on
 * a shared worker it is the only thing saying which workspace may see this
 * endpoint at all.
 */
export const externalMcpServers = pgTable(
  "orchestrator_external_mcp_servers",
  {
    /** Server id — the `mcp__<server>__<tool>` namespace. */
    id: text("id").primaryKey(),
    /** `ExternalMcpServer` as attached: transport, endpoint, env var names. */
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    /** `crew:<address>` / `agent:<address>` of whoever attached it; null = the operator's. */
    ownerKey: text("owner_key"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("external_mcp_servers_owner_idx").on(table.ownerKey)],
);
