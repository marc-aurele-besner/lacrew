import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Orchestrator audit trail (ProtocolEvent rows). Written by the runtime on
 * propose/resolve/session/governance activity so /audit survives restarts;
 * the Ponder indexer (F1.11) will feed the same consumer schema later.
 */
export const auditEvents = pgTable(
  "orchestrator_audit_events",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    /** Event timestamp (ISO from the runtime), distinct from row insert time. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    orgId: text("org_id"),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_events_at_idx").on(table.at)],
);
