/**
 * Executing Safe transactions with a signer (PRD F1.8).
 *
 * Granting a seat its budget is itself a Safe transaction, so the owner side
 * needs a way to sign and send. Kept separate from the tx builders in
 * `allowance.ts` so the non-custodial surface stays usable on its own: nothing
 * here is reachable without a caller-supplied signer.
 */

import { createPublicClient, http } from "viem";
import { reportTransactionGas, type GasPayer, type GasReceiptSink } from "@lacrew/core";
import { loadSafeKit, type SafeWalletConfig } from "./safe.js";
import type { MetaTransaction } from "./allowance.js";

export type SafeExecuteConfig = SafeWalletConfig & {
  safeAddress: `0x${string}`;
  /** Required — these paths sign and broadcast. */
  signer: string;
  /** Told what each executed Safe transaction cost, with the Safe as the agent seat. */
  onReceipt?: GasReceiptSink;
  /** Who holds the signer key. Defaults to `agent`: a seat's owner acting for the seat. */
  payer?: GasPayer;
};

export type SafeExecutionResult = {
  transactionHash: `0x${string}`;
};

async function initSafe(config: SafeExecuteConfig) {
  const Safe = await loadSafeKit();
  return Safe.init({
    provider: config.provider,
    signer: config.signer,
    safeAddress: config.safeAddress,
  });
}

function hashOf(result: { hash?: string; transactionResponse?: unknown }): `0x${string}` {
  return (result.hash ?? "0x") as `0x${string}`;
}

/**
 * Report what an executed Safe transaction cost. Reads the receipt through the
 * config's own RPC; a transaction with no hash or no receipt reports nothing.
 */
async function reportSafeExecution(
  config: SafeExecuteConfig,
  hash: `0x${string}`,
  kind: string,
): Promise<void> {
  if (!config.onReceipt || hash === "0x") return;
  try {
    const client = createPublicClient({ transport: http(config.provider) });
    await reportTransactionGas(
      client,
      hash,
      {
        chainId: await client.getChainId(),
        kind,
        payer: config.payer ?? "agent",
        agent: config.safeAddress,
      },
      config.onReceipt,
    );
  } catch {
    // Bookkeeping only: the Safe transaction already went out.
  }
}

/** Whether a module is already enabled — enabling twice reverts. */
export async function isModuleEnabled(
  config: SafeExecuteConfig,
  moduleAddress: `0x${string}`,
): Promise<boolean> {
  const safe = await initSafe(config);
  return safe.isModuleEnabled(moduleAddress);
}

/**
 * Enable a module on the Safe. No-ops when it is already enabled so setup is
 * idempotent — re-running a seat's provisioning must not revert.
 */
export async function enableSafeModule(
  config: SafeExecuteConfig,
  moduleAddress: `0x${string}`,
): Promise<SafeExecutionResult | null> {
  const safe = await initSafe(config);
  if (await safe.isModuleEnabled(moduleAddress)) return null;
  const tx = await safe.createEnableModuleTx(moduleAddress);
  const signed = await safe.signTransaction(tx);
  const result = await safe.executeTransaction(signed);
  await reportSafeExecution(config, hashOf(result), "safe enable module");
  return { transactionHash: hashOf(result) };
}

/**
 * Execute meta transactions as the Safe. Multiple entries are batched through
 * MultiSend, so a delegate registration and its allowance land atomically —
 * a seat is never left registered with no budget or vice versa.
 */
export async function executeSafeTransactions(
  config: SafeExecuteConfig,
  transactions: MetaTransaction[],
): Promise<SafeExecutionResult> {
  if (transactions.length === 0) {
    throw new Error("executeSafeTransactions() needs at least one transaction.");
  }
  const safe = await initSafe(config);
  const tx = await safe.createTransaction({
    transactions: transactions.map((t) => ({
      to: t.to,
      data: t.data,
      value: t.value.toString(),
    })),
  });
  const signed = await safe.signTransaction(tx);
  const result = await safe.executeTransaction(signed);
  await reportSafeExecution(config, hashOf(result), "safe exec");
  return { transactionHash: hashOf(result) };
}
