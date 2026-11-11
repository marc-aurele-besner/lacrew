import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Minimal meta row for migrate smoke / health checks. */
export const orchestratorMeta = pgTable(
  "orchestrator_meta",
  {
    /** The org this row belongs to. Every read and write is scoped by it. */
    orgId: text("org_id").notNull().default("default"),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.key] })],
);
