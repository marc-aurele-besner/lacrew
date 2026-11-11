/**
 * GasStore: pluggable persistence for what each transaction this orchestrator
 * sent cost in gas. Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set,
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
import type { WriteReceipt } from "@lacrew/sdk";

/**
 * One sent transaction's gas. Amounts are decimal strings, never JS numbers:
 * a fee in wei passes 2^53 well inside ordinary use.
 */
export interface TxGasRecord {
  chainId: number;
  /** Lower-cased. */
  txHash: string;
  /** ISO timestamp the receipt was read at. */
  at: string;
  /** What the transaction was for ("propose", "resolve", "session issue", …). */
  action: string;
  /** Lower-cased account that signed and paid. */
  sender: string | null;
  /** Lower-cased agent the transaction was sent for; null until an audit event names one. */
  agent: string | null;
  status: "success" | "reverted";
  gasUsed: string;
  /** Null when the receipt carried no effective gas price. */
  effectiveGasPrice: string | null;
  /** OP-stack L1 data fee; null when the receipt carried none. */
  l1FeeWei: string | null;
  /**
   * `gasUsed × effectiveGasPrice` plus any L1 fee. Null when the receipt had
   * no price: the fee is then unknown, and unknown is not zero.
   */
  feeWei: string | null;
}

/** Fold a write receipt into the record that is stored for it. */
export function txGasFromReceipt(
  receipt: Pick<
    WriteReceipt,
    "txHash" | "action" | "status" | "gasUsed" | "effectiveGasPrice" | "l1Fee"
  > & { from?: string },
  chainId: number,
  at: string,
): TxGasRecord {
  const price = receipt.effectiveGasPrice;
  const fee = price === undefined ? null : receipt.gasUsed * price + (receipt.l1Fee ?? 0n);
  return {
    chainId,
    txHash: receipt.txHash.toLowerCase(),
    at,
    action: receipt.action,
    sender: receipt.from?.toLowerCase() ?? null,
    agent: null,
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: price === undefined ? null : price.toString(),
    l1FeeWei: receipt.l1Fee === undefined ? null : receipt.l1Fee.toString(),
    feeWei: fee === null ? null : fee.toString(),
  };
}

export interface GasStore {
  readonly name: string;
  /** Persist one transaction's gas; must never throw into the caller's flow. */
  append(record: TxGasRecord): Promise<void>;
  /** Name the agent a recorded transaction was sent for; the first one stands. */
  attributeAgent(chainId: number, txHash: string, agent: string): Promise<void>;
  /**
   * Summed fee (wei, decimal string) and the number of transactions that had a
   * fee, per UTC day over `[fromIso, toIso)`; days with no transaction are
   * absent. Null when the store cannot answer completely (memory store, or a
   * read failure) — the caller falls back to its bounded ring and says so.
   */
  sumByDayBetween(
    fromIso: string,
    toIso: string,
  ): Promise<Array<{ day: string; feeWei: string; txCount: number }> | null>;
  /** The same sums per agent (null for transactions tied to none). */
  sumByAgentBetween(
    fromIso: string,
    toIso: string,
  ): Promise<Array<{ agent: string | null; feeWei: string; txCount: number }> | null>;
  close(): Promise<void>;
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
        return await sumTxGasByDay(db(), fromIso, toIso, scope);
      } catch (err) {
        console.error("[@lacrew/orchestrator] gas daily sum failed:", err);
        return null;
      }
    },
    sumByAgentBetween: async (fromIso, toIso) => {
      try {
        await tail;
        return await sumTxGasByAgent(db(), fromIso, toIso, scope);
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
