/**
 * GasStore: pluggable persistence for what each transaction cost in gas and
 * who paid. Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set,
 * else a memory no-op — same provider pattern as AuditStore.
 */

import {
  createDb,
  getDatabaseUrl,
  insertTxGas,
  setTxGasAgent,
  sumTxGasByAgent,
  sumTxGasByDay,
  type DbHandle,
} from "@lacrew/db";
import { isGasPayer, type GasPayer, type GasReceipt } from "@lacrew/core";

/**
 * One transaction's gas. Amounts are decimal strings, never JS numbers: a fee
 * in wei passes 2^53 well inside ordinary use.
 */
export interface TxGasRecord {
  chainId: number;
  /** Lower-cased; for a user operation, the bundle transaction that included it. */
  txHash: string;
  /** Lower-cased user operation hash; null for a plain transaction. */
  userOpHash: string | null;
  /** ISO timestamp the receipt was read at. */
  at: string;
  /** What the transaction was for ("propose", "resolve", "session issue", …). */
  action: string;
  /** Lower-cased account that sent it. */
  sender: string | null;
  /** Who bore the fee. */
  payer: GasPayer;
  /** Lower-cased paymaster that paid, when `payer` is `sponsored`. */
  paymaster: string | null;
  /** Lower-cased agent the transaction was sent for; null until something names one. */
  agent: string | null;
  status: "success" | "reverted";
  gasUsed: string;
  /** Null when the receipt carried no effective gas price. */
  effectiveGasPrice: string | null;
  /** OP-stack L1 data fee; null when the receipt carried none. */
  l1FeeWei: string | null;
  /** The whole fee. Null when unknown, and unknown is not zero. */
  feeWei: string | null;
}

/** Fold a reported gas receipt into the record that is stored for it. */
export function txGasFromReceipt(receipt: GasReceipt, at: string): TxGasRecord {
  const text = (value: bigint | undefined) => (value === undefined ? null : value.toString());
  return {
    chainId: receipt.chainId,
    txHash: receipt.txHash.toLowerCase(),
    userOpHash: receipt.userOpHash?.toLowerCase() ?? null,
    at,
    action: receipt.kind,
    sender: receipt.sender?.toLowerCase() ?? null,
    payer: receipt.payer,
    paymaster: receipt.paymaster?.toLowerCase() ?? null,
    agent: receipt.agent?.toLowerCase() ?? null,
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: text(receipt.effectiveGasPrice),
    l1FeeWei: text(receipt.l1Fee),
    feeWei: text(receipt.feeWei),
  };
}

/** A summed fee and how many transactions had one, for one payer. */
export type GasSum = { payer: GasPayer; feeWei: string; txCount: number };

export interface GasStore {
  readonly name: string;
  /** Persist one transaction's gas; must never throw into the caller's flow. */
  append(record: TxGasRecord): Promise<void>;
  /** Name the agent a recorded transaction was sent for; the first one stands. */
  attributeAgent(chainId: number, txHash: string, agent: string): Promise<void>;
  /**
   * Summed fee (wei, decimal string) and the number of transactions that had a
   * fee, per UTC day and payer over `[fromIso, toIso)`; days with no
   * transaction are absent. Null when the store cannot answer completely (memory store, or a
   * read failure) — the caller falls back to its bounded ring and says so.
   */
  sumByDayBetween(fromIso: string, toIso: string): Promise<Array<{ day: string } & GasSum> | null>;
  /** The same sums per agent (null for transactions tied to none). */
  sumByAgentBetween(
    fromIso: string,
    toIso: string,
  ): Promise<Array<{ agent: string | null } & GasSum> | null>;
  close(): Promise<void>;
}

/** Narrows a stored payer; a row written with a name this build does not know is left out. */
function knownPayer<T extends { payer: string }>(row: T): row is T & { payer: GasPayer } {
  return isGasPayer(row.payer);
}

/** No-op store for mock demos and tests. */
export function createMemoryGasStore(): GasStore {
  return {
    name: "memory",
    append: async () => {},
    attributeAgent: async () => {},
    sumByDayBetween: async () => null,
    sumByAgentBetween: async () => null,
    close: async () => {},
  };
}

/**
 * Postgres-backed store. When `chainId` is set every read answers only that
 * chain, as the audit store's do, so two orchestrators on different chains can
 * share a database without summing each other's fees.
 */
export function createPgGasStore(url = getDatabaseUrl(), chainId?: number): GasStore {
  let handle: DbHandle | undefined;
  const db = () => (handle ??= createDb(url));
  const scope = chainId === undefined ? undefined : { chainId };
  // Writes run one after another: an attribution issued right behind its
  // transaction's insert must find the row there.
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (what: string, write: () => Promise<void>): Promise<void> => {
    tail = tail.then(write).catch((err) => {
      console.error(`[@lacrew/orchestrator] gas ${what} failed:`, err);
    });
    return tail;
  };

  return {
    name: "postgres",
    append: (record) => enqueue("append", () => insertTxGas(db(), record)),
    attributeAgent: (chain, txHash, agent) =>
      enqueue("attribution", () => setTxGasAgent(db(), chain, txHash, agent)),
    sumByDayBetween: async (fromIso, toIso) => {
      try {
        await tail;
        return (await sumTxGasByDay(db(), fromIso, toIso, scope)).filter(knownPayer);
      } catch (err) {
        console.error("[@lacrew/orchestrator] gas daily sum failed:", err);
        return null;
      }
    },
    sumByAgentBetween: async (fromIso, toIso) => {
      try {
        await tail;
        return (await sumTxGasByAgent(db(), fromIso, toIso, scope)).filter(knownPayer);
      } catch (err) {
        console.error("[@lacrew/orchestrator] gas agent sum failed:", err);
        return null;
      }
    },
    close: async () => {
      await tail;
      await handle?.close();
      handle = undefined;
    },
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createGasStoreFromEnv(chainId?: number): GasStore {
  return getDatabaseUrl() ? createPgGasStore(getDatabaseUrl(), chainId) : createMemoryGasStore();
}
