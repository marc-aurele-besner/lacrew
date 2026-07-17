import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Minimal meta row for migrate smoke / health checks. */
export const orchestratorMeta = pgTable("orchestrator_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
