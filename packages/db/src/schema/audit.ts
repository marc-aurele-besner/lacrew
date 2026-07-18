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
 * (chain logs, deduped on tx_hash + log_index; NULLs never conflict so
 * runtime rows without chain coordinates coexist).
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
    /** Chain coordinates when sourced from a log (indexer). */
    txHash: text("tx_hash"),
    logIndex: integer("log_index"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_at_idx").on(table.at),
    uniqueIndex("audit_events_tx_log_idx").on(table.txHash, table.logIndex),
  ],
);
