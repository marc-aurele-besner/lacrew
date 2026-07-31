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
