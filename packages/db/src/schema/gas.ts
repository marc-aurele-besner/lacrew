import {
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * What each transaction cost in gas and who paid — one row per transaction,
 * keyed by (chain_id, tx_hash, user_op_hash). `tx_hash` is also what an audit
 * event's `payload.txHash` names. A user operation is a row of its own under
 * the bundle transaction that included it, since one bundle carries several.
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
    /** The org this row belongs to. Every read and write is scoped by it. */
    orgId: text("org_id").notNull().default("default"),
    id: serial("id").primaryKey(),
    /** EIP-155 chain id the transaction was sent on. */
    chainId: integer("chain_id").notNull(),
    /** Lower-cased transaction hash. */
    txHash: text("tx_hash").notNull(),
    /** When the receipt was read. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** What the transaction was for ("propose", "resolve", "session issue", …). */
    action: text("action").notNull(),
    /**
     * Lower-cased user operation hash; the empty string for a plain
     * transaction, so the unique key needs no null handling.
     */
    userOpHash: text("user_op_hash").notNull().default(""),
    /** Lower-cased account that sent it: a transaction's `from`, a user operation's `sender`. */
    sender: text("sender"),
    /** Who bore the fee: `orchestrator`, `agent`, `approver` or `sponsored`. */
    payer: text("payer").notNull().default("orchestrator"),
    /** Lower-cased paymaster that paid, when `payer` is `sponsored`. */
    paymaster: text("paymaster"),
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
     * `gas_used × effective_gas_price` plus the L1 fee, in wei; for a user
     * operation, its `actualGasCost`. Null when unknown, which is not zero.
     */
    feeWei: numeric("fee_wei", { precision: 78, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tx_gas_chain_tx_op_idx").on(
      table.orgId,
      table.chainId,
      table.txHash,
      table.userOpHash,
    ),
    index("tx_gas_chain_at_idx").on(table.orgId, table.chainId, table.at),
  ],
);
