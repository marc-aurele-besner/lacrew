import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Audit trail (ProtocolEvent rows) — the stable consumer schema (F1.11).
 * Written by the orchestrator runtime (its own activity) and by the indexer
 * (chain logs, deduped on chain_id + tx_hash + log_index so one indexer
 * process per chain can share this table; NULLs never conflict so runtime
 * rows without chain coordinates coexist).
 */
export const auditEvents = pgTable(
  "orchestrator_audit_events",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    /** Event timestamp (ISO from the runtime, block time from the indexer). */
    at: timestamp("at", { withTimezone: true }).notNull(),
    orgId: text("org_id"),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    /**
     * EIP-155 chain id. Not null on every chain-sourced row (and on runtime
     * rows whose orchestrator knows its chain); null only for rows with no
     * chain at all. Rows written before this column exist as chain 31337 —
     * everything predating it came from the Anvil-era single-chain stack.
     */
    chainId: integer("chain_id"),
    /** Chain coordinates when sourced from a log (indexer). */
    txHash: text("tx_hash"),
    logIndex: integer("log_index"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_at_idx").on(table.at),
    index("audit_events_chain_at_idx").on(table.chainId, table.at),
    uniqueIndex("audit_events_chain_tx_log_idx").on(table.chainId, table.txHash, table.logIndex),
  ],
);
