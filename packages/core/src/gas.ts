/**
 * The gas-receipt hook: one shape for "this is what a transaction cost, and
 * who paid", reported by whichever code saw the receipt.
 *
 * The orchestrator's own SDK client reports its writes itself. Everything else
 * that broadcasts — a wallet adapter sending for an agent seat, a relayer, a
 * CLI command, a bundler submitting a user operation — takes an `onReceipt`
 * sink and calls it after the send, so all of them land in the same ledger.
 *
 * The sink is passed explicitly rather than registered process-wide: a process
 * hosting several orchestrators must never report one's gas into another's
 * ledger.
 */

/** Who bore a transaction's fee. */
export const GAS_PAYERS = ["orchestrator", "agent", "approver", "sponsored"] as const;

/**
 * - `orchestrator` — a key the operator runs: the orchestrator's signer, the
 *   session keys it holds and funds, its relayers, and operator tooling.
 * - `agent` — an agent seat's own wallet.
 * - `approver` — a human approver's own wallet.
 * - `sponsored` — a paymaster paid; the fee cost the sender nothing.
 */
export type GasPayer = (typeof GAS_PAYERS)[number];

export function isGasPayer(value: unknown): value is GasPayer {
  return typeof value === "string" && (GAS_PAYERS as readonly string[]).includes(value);
}

/** What one mined transaction (or one user operation) cost. */
export type GasReceipt = {
  /** EIP-155 chain id it was mined on. */
  chainId: number;
  /** The transaction; for a user operation, the bundle transaction that included it. */
  txHash: `0x${string}`;
  /** Set for a user operation — several can share one bundle transaction. */
  userOpHash?: `0x${string}`;
  /** What it was for ("propose", "goat send", "safe exec", …). */
  kind: string;
  /** Reverted ones are reported too: they were still paid for. */
  status: "success" | "reverted";
  gasUsed: bigint;
  /** Absent when the receipt carried none. */
  effectiveGasPrice?: bigint;
  /** The L1 data fee an OP-stack chain bills on top of L2 gas. */
  l1Fee?: bigint;
  /**
   * The whole fee in wei. Absent when it cannot be known (a receipt with no
   * gas price) — unknown, which is not zero.
   */
  feeWei?: bigint;
  payer: GasPayer;
  /** The account that sent it: a transaction's `from`, a user operation's `sender`. */
  sender?: `0x${string}`;
  /** The paymaster that paid, when `payer` is `sponsored`. */
  paymaster?: `0x${string}`;
  /** The agent seat it was sent for, when the reporter knows. */
  agent?: `0x${string}`;
};

/** Where receipts are reported. A sink is bookkeeping and may be async. */
export type GasReceiptSink = (receipt: GasReceipt) => void | Promise<void>;

/** What the reporter knows that the receipt does not say. */
export type GasReceiptContext = {
  chainId: number;
  kind: string;
  payer: GasPayer;
  agent?: `0x${string}`;
};

/** A fee field as a receipt may carry it: already a bigint, or a raw hex quantity. */
export function receiptQuantity(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  return undefined;
}

/** The slice of a transaction receipt a fee is read from (viem's, or raw JSON-RPC). */
export type TransactionReceiptLike = {
  transactionHash: `0x${string}`;
  from?: `0x${string}`;
  status: unknown;
  gasUsed: unknown;
  effectiveGasPrice?: unknown;
  l1Fee?: unknown;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function succeeded(status: unknown): boolean {
  return status === "success" || status === true || status === "0x1" || status === 1;
}

/**
 * Fold a transaction receipt into a `GasReceipt`: `gasUsed × effectiveGasPrice`
 * plus any L1 fee. Without a price the fee is left unknown — an L1 fee alone is
 * not passed off as the whole.
 */
export function gasReceiptFromTransaction(
  receipt: TransactionReceiptLike,
  context: GasReceiptContext,
): GasReceipt {
  const gasUsed = receiptQuantity(receipt.gasUsed) ?? 0n;
  const effectiveGasPrice = receiptQuantity(receipt.effectiveGasPrice);
  const l1Fee = receiptQuantity(receipt.l1Fee);
  return {
    chainId: context.chainId,
    txHash: receipt.transactionHash,
    kind: context.kind,
    status: succeeded(receipt.status) ? "success" : "reverted",
    gasUsed,
    ...(effectiveGasPrice === undefined ? {} : { effectiveGasPrice }),
    ...(l1Fee === undefined ? {} : { l1Fee }),
    ...(effectiveGasPrice === undefined
      ? {}
      : { feeWei: gasUsed * effectiveGasPrice + (l1Fee ?? 0n) }),
    payer: context.payer,
    ...(receipt.from ? { sender: receipt.from } : {}),
    ...(context.agent ? { agent: context.agent } : {}),
  };
}

/** The slice of an ERC-4337 UserOperation receipt a fee is read from. */
export type UserOperationReceiptLike = {
  userOpHash: `0x${string}`;
  sender?: `0x${string}`;
  paymaster?: `0x${string}` | null;
  /** What the operation was charged, in wei — the EntryPoint's own figure. */
  actualGasCost: unknown;
  actualGasUsed: unknown;
  success: unknown;
  /** The bundle transaction. Only its hash is used: its fee is the bundler's. */
  receipt: { transactionHash: `0x${string}` };
};

/**
 * Fold a UserOperation receipt into a `GasReceipt`.
 *
 * The fee is the operation's `actualGasCost`, never the bundle transaction's:
 * a bundle carries other senders' operations and is paid by the bundler. When
 * a paymaster is named the operation is `sponsored` and the paymaster is who
 * paid; otherwise the smart account paid out of its own deposit, as
 * `selfPayer` (an agent seat's wallet unless the caller says otherwise).
 */
export function gasReceiptFromUserOperation(
  receipt: UserOperationReceiptLike,
  context: Omit<GasReceiptContext, "payer"> & { selfPayer?: Exclude<GasPayer, "sponsored"> },
): GasReceipt {
  const paymaster =
    receipt.paymaster && receipt.paymaster.toLowerCase() !== ZERO_ADDRESS
      ? receipt.paymaster
      : undefined;
  const feeWei = receiptQuantity(receipt.actualGasCost);
  return {
    chainId: context.chainId,
    txHash: receipt.receipt.transactionHash,
    userOpHash: receipt.userOpHash,
    kind: context.kind,
    status: succeeded(receipt.success) ? "success" : "reverted",
    gasUsed: receiptQuantity(receipt.actualGasUsed) ?? 0n,
    ...(feeWei === undefined ? {} : { feeWei }),
    payer: paymaster ? "sponsored" : (context.selfPayer ?? "agent"),
    ...(receipt.sender ? { sender: receipt.sender } : {}),
    ...(paymaster ? { paymaster } : {}),
    ...(context.agent ? { agent: context.agent } : {}),
  };
}

/**
 * Hand a receipt to a sink. Never throws and never rejects: a sink is
 * bookkeeping, and must not turn a landed transaction into a failure.
 */
export async function reportGasReceipt(
  onReceipt: GasReceiptSink | undefined,
  receipt: GasReceipt,
): Promise<void> {
  if (!onReceipt) return;
  try {
    await onReceipt(receipt);
  } catch {
    // Dropped on purpose — see above.
  }
}

/** Reads a mined transaction's receipt — satisfied by a viem `PublicClient`. */
export type TransactionReceiptReader = {
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<TransactionReceiptLike>;
};

/**
 * Read a sent transaction's receipt and report what it cost. Returns what was
 * reported, or undefined when there is no sink or the receipt could not be
 * read — a fee is never guessed.
 */
export async function reportTransactionGas(
  reader: TransactionReceiptReader,
  hash: `0x${string}`,
  context: GasReceiptContext,
  onReceipt: GasReceiptSink | undefined,
): Promise<GasReceipt | undefined> {
  if (!onReceipt) return undefined;
  let report: GasReceipt;
  try {
    report = gasReceiptFromTransaction(await reader.waitForTransactionReceipt({ hash }), context);
  } catch {
    return undefined;
  }
  await reportGasReceipt(onReceipt, report);
  return report;
}

/** Reads a UserOperation receipt — satisfied by a viem bundler client. */
export type UserOperationReceiptReader = {
  waitForUserOperationReceipt(args: { hash: `0x${string}` }): Promise<UserOperationReceiptLike>;
};

/** The user-operation counterpart of `reportTransactionGas`. */
export async function reportUserOperationGas(
  bundler: UserOperationReceiptReader,
  userOpHash: `0x${string}`,
  context: Parameters<typeof gasReceiptFromUserOperation>[1],
  onReceipt: GasReceiptSink | undefined,
): Promise<GasReceipt | undefined> {
  if (!onReceipt) return undefined;
  let report: GasReceipt;
  try {
    report = gasReceiptFromUserOperation(
      await bundler.waitForUserOperationReceipt({ hash: userOpHash }),
      context,
    );
  } catch {
    return undefined;
  }
  await reportGasReceipt(onReceipt, report);
  return report;
}
