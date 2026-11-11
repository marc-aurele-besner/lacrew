import { bigint, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The simulator's whole state for one org in sandbox mode: the serialised
 * world, and how far its clock has been advanced past wall time.
 *
 * One row per org, replaced on every committed simulator transaction.
 * `version` counts those writes and is the optimistic lock: a write names the
 * version it read and lands only if the row still holds it, so two processes
 * serving one org cannot silently overwrite each other's state.
 *
 * Nothing here was mined. This is the record of a simulation, kept so a
 * restart resumes it.
 */
export const sandboxState = pgTable("orchestrator_sandbox_state", {
  orgId: text("org_id").primaryKey(),
  version: integer("version").notNull(),
  state: jsonb("state").notNull().$type<unknown>(),
  /** Seconds the sandbox clock runs ahead of wall time. */
  clockOffset: bigint("clock_offset", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
