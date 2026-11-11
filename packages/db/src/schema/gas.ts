import {
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * What each transaction the orchestrator sent cost in gas — one row per
 * transaction, keyed by (chain_id, tx_hash), which is also what an audit
 * event's `payload.txHash` names.
 *
 * A table of its own rather than columns on the audit trail because the two do
 * not line up one to one: a single transaction can raise several audit events
 * (the intent and the action it executed), an action can take several
 * transactions (an approve before a purchase), and a reverted transaction is
 * paid for while raising no event at all. Keyed by transaction, each one is
 * counted exactly once.
 *
 * Wei amounts are `numeric(78, 0)` — wide enough for a uint256 — and read back
 * as decimal strings, never as JS numbers.
 */
export const txGas = pgTable(
  "orchestrator_tx_gas",
  {
    id: serial("id").primaryKey(),
    /** EIP-155 chain id the transaction was sent on. */
    chainId: integer("chain_id").notNull(),
    /** Lower-cased transaction hash. */
    txHash: text("tx_hash").notNull(),
    /** When the receipt was read. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** What the transaction was for ("propose", "resolve", "session issue", …). */
    action: text("action").notNull(),
    /** Lower-cased account that signed and paid. */
    sender: text("sender"),
    /**
     * Lower-cased agent the transaction was sent for, taken from the audit
     * event that names both it and an agent; null when none does.
     */
    agent: text("agent"),
    /** `success` or `reverted`. */
    status: text("status").notNull(),
    gasUsed: numeric("gas_used", { precision: 78, scale: 0 }).notNull(),
    /** Null when the receipt carried no effective gas price. */
    effectiveGasPrice: numeric("effective_gas_price", { precision: 78, scale: 0 }),
    /** OP-stack L1 data fee, when the receipt carried one. */
    l1FeeWei: numeric("l1_fee_wei", { precision: 78, scale: 0 }),
    /**
     * `gas_used × effective_gas_price` plus the L1 fee, in wei. Null when
     * there was no price to multiply by — unknown, which is not zero.
     */
    feeWei: numeric("fee_wei", { precision: 78, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tx_gas_chain_tx_idx").on(table.chainId, table.txHash),
    index("tx_gas_chain_at_idx").on(table.chainId, table.at),
  ],
);
