import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The org directory of a multi-org orchestrator: which orgs this process
 * serves, and what each one is.
 *
 * An org exists here because somebody registered it by name. Nothing creates
 * a row by addressing an org that is not in it, so a mistyped id is answered
 * "not found" instead of becoming a new, empty organisation.
 *
 * Every other orchestrator table carries `org_id` as a scope. Here it is the
 * key: the row is the org.
 */
export const orgs = pgTable("orchestrator_orgs", {
  orgId: text("org_id").primaryKey(),
  /** `sandbox` (simulated, no chain), `testnet` or `mainnet`. */
  mode: text("mode").notNull(),
  /** EIP-155 chain id of a chain org; null for a sandbox. */
  chainId: integer("chain_id"),
  /** The org's deployed contract addresses, by name; null until it has any. */
  addresses: jsonb("addresses").$type<Record<string, string>>(),
  /**
   * The accounts that hold the org's seats, by role (`root`, ...). Addresses
   * only: no key is ever stored here.
   */
  seats: jsonb("seats").$type<Record<string, string>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
