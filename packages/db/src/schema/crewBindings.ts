import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Blueprint seat → account, kept by the orchestrator itself (F2.25).
 *
 * The chain stores no labels and no role ids, so the mapping a blueprint
 * install learns has to live off-chain or be lost. A self-host had nowhere to
 * put it and carried it on the command line instead; this is that place.
 *
 * One row per role id per scope, because two crews installed from the same
 * blueprint each have their own `reviewer`. Nothing here is authority: the row
 * *finds* a seat whose readiness is still derived from live reads.
 */
export const crewBindings = pgTable(
  "orchestrator_crew_bindings",
  {
    /** `<scope>|<roleId>` — `crew:<id>`, `blueprint:<id>`, or `workspace`. */
    key: text("key").primaryKey(),
    /** The scope half of the key, so a crew's bindings can be read as a set. */
    scopeKey: text("scope_key").notNull(),
    roleId: text("role_id").notNull(),
    /** Lowercased account the hire minted. */
    account: text("account").notNull(),
    /** The label at bind time — a breadcrumb, never how a seat is resolved. */
    label: text("label"),
    blueprintId: text("blueprint_id"),
    crewId: text("crew_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("crew_bindings_account_idx").on(table.account)],
);
