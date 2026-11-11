/** Query helpers for the per-transaction gas ledger (keeps Drizzle inside @lacrew/db). */

import { and, count, eq, gte, isNull, lt, sql, type SQL } from "drizzle-orm";
import { txGas } from "./schema/gas.js";
import type { DbHandle } from "./client.js";

export interface TxGasRow {
  chainId: number;
  txHash: string;
  /** ISO timestamp the receipt was read at. */
  at: string;
  action: string;
  /** Set for a user operation; a plain transaction has none. */
  userOpHash?: string | null;
  sender?: string | null;
  /** `orchestrator`, `agent`, `approver` or `sponsored`. */
  payer: string;
  paymaster?: string | null;
  agent?: string | null;
  status: string;
  /** Decimal strings throughout: wei does not fit a JS number. */
  gasUsed: string;
  effectiveGasPrice?: string | null;
  l1FeeWei?: string | null;
  feeWei?: string | null;
}

/** Optional chain scope for reads, as on the audit trail. */
export interface TxGasReadOptions {
  chainId?: number;
}

function chainScope(options?: TxGasReadOptions): SQL | undefined {
  return options?.chainId === undefined ? undefined : eq(txGas.chainId, options.chainId);
}

/**
 * Record one transaction's gas. Idempotent on (chain_id, tx_hash,
 * user_op_hash): reported twice, it is still one row and one fee.
 */
export async function insertTxGas(handle: DbHandle, row: TxGasRow): Promise<void> {
  await handle.db
    .insert(txGas)
    .values({
      chainId: row.chainId,
      txHash: row.txHash.toLowerCase(),
      at: new Date(row.at),
      action: row.action,
      userOpHash: row.userOpHash?.toLowerCase() ?? "",
      sender: row.sender?.toLowerCase() ?? null,
      payer: row.payer,
      paymaster: row.paymaster?.toLowerCase() ?? null,
      agent: row.agent?.toLowerCase() ?? null,
      status: row.status,
      gasUsed: row.gasUsed,
      effectiveGasPrice: row.effectiveGasPrice ?? null,
      l1FeeWei: row.l1FeeWei ?? null,
      feeWei: row.feeWei ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Name the agent a recorded transaction was sent for. The first attribution
 * stands: a later event naming another agent for the same transaction does
 * not move a fee that a report may already have shown under the first.
 */
export async function setTxGasAgent(
  handle: DbHandle,
  chainId: number,
  txHash: string,
  agent: string,
): Promise<void> {
  await handle.db
    .update(txGas)
    .set({ agent: agent.toLowerCase() })
    .where(
      and(eq(txGas.chainId, chainId), eq(txGas.txHash, txHash.toLowerCase()), isNull(txGas.agent)),
    );
}

/**
 * Summed fee in wei and the number of transactions that had one, per UTC day
 * and payer over `[fromIso, toIso)`. A transaction whose fee is unknown adds
 * to neither. Only (day, payer) pairs with a recorded transaction come back.
 */
export async function sumTxGasByDay(
  handle: DbHandle,
  fromIso: string,
  toIso: string,
  options?: TxGasReadOptions,
): Promise<Array<{ day: string; payer: string; feeWei: string; txCount: number }>> {
  const day = sql<string>`to_char(${txGas.at} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await handle.db
    .select({
      day,
      payer: txGas.payer,
      feeWei: sql<string>`coalesce(sum(${txGas.feeWei}), 0)::text`,
      txCount: count(txGas.feeWei),
    })
    .from(txGas)
    .where(
      and(gte(txGas.at, new Date(fromIso)), lt(txGas.at, new Date(toIso)), chainScope(options)),
    )
    .groupBy(day, txGas.payer)
    .orderBy(day, txGas.payer);
  return rows.map((row) => ({
    day: row.day,
    payer: row.payer,
    feeWei: row.feeWei,
    txCount: Number(row.txCount),
  }));
}

/**
 * The same sums per agent and payer over `[fromIso, toIso)`. Transactions
 * nothing tied to an agent answer under `null`, so the rows still sum to the
 * window's total.
 */
export async function sumTxGasByAgent(
  handle: DbHandle,
  fromIso: string,
  toIso: string,
  options?: TxGasReadOptions,
): Promise<Array<{ agent: string | null; payer: string; feeWei: string; txCount: number }>> {
  const rows = await handle.db
    .select({
      agent: txGas.agent,
      payer: txGas.payer,
      feeWei: sql<string>`coalesce(sum(${txGas.feeWei}), 0)::text`,
      txCount: count(txGas.feeWei),
    })
    .from(txGas)
    .where(
      and(gte(txGas.at, new Date(fromIso)), lt(txGas.at, new Date(toIso)), chainScope(options)),
    )
    .groupBy(txGas.agent, txGas.payer)
    .orderBy(txGas.agent, txGas.payer);
  return rows.map((row) => ({
    agent: row.agent,
    payer: row.payer,
    feeWei: row.feeWei,
    txCount: Number(row.txCount),
  }));
}
