/**
 * GOAT (Great Onchain Agent Toolkit) wallets as agent seat wallets (PRD F3.3).
 *
 * GOAT's model is a wallet client plus the tools that call it: a plugin's tool
 * spends by invoking `sendTransaction` on the client it was handed. So the seat
 * is whatever account that client holds — there is no per-label factory here as
 * there is for Safe and MetaMask, and one adapter describes one seat.
 *
 * `@goat-sdk/wallet-viem` is an optional peer, loaded only when a caller asks
 * this package to build the client. Nothing here holds key material or
 * broadcasts; the caller owns the signer, as in the CDP, Safe and MetaMask
 * adapters.
 */

import type { WalletClient } from "viem";

/** GOAT's chain descriptor, narrowed to what a seat needs from it. */
export type GoatChain = { type: string; id?: number };

/** A GOAT transaction request: raw `data`, or a function call to encode. */
export type GoatTransaction = {
  to: string;
  value?: bigint;
  data?: `0x${string}`;
  functionName?: string;
  args?: unknown[];
  abi?: unknown;
};

/**
 * The slice of GOAT's `EVMWalletClient` this package uses. Structural on
 * purpose: an adapter depends on the shape, never on the vendor package, so a
 * caller can pass a real client, a fake, or a gated wrapper interchangeably.
 */
export type GoatWalletClient = {
  getAddress(): string;
  getChain(): GoatChain;
  sendTransaction(transaction: GoatTransaction): Promise<{ hash: string }>;
};

export type GoatWallet = {
  address: `0x${string}`;
  provider: "goat";
  chainId: number;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Seat handle for a GOAT wallet client.
 *
 * A viem client with no account makes GOAT's `getAddress()` return the empty
 * string rather than fail, so an unconfigured signer would otherwise arrive
 * here as a seat with nothing behind it — and a seat with no address is the one
 * thing a wallet adapter must never hand back as if it were funded.
 */
export async function createGoatWallet(opts: { wallet: GoatWalletClient }): Promise<GoatWallet> {
  const address = opts.wallet.getAddress();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || address.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      "GOAT wallet credentials missing — the wallet client reported no account address. " +
        "Build it from a viem WalletClient that has an account.",
    );
  }
  const chain = opts.wallet.getChain();
  if (chain.type !== "evm" || typeof chain.id !== "number") {
    throw new Error(
      `GOAT wallet reports a "${chain.type}" chain. LaCrew policy modules are EVM contracts, ` +
        "so only GOAT's EVM wallet clients can be checked against them.",
    );
  }
  return { address: address as `0x${string}`, provider: "goat", chainId: chain.id };
}

async function loadGoatViem() {
  try {
    return await import("@goat-sdk/wallet-viem");
  } catch {
    throw new Error(
      "@goat-sdk/wallet-viem is not installed — pnpm add @goat-sdk/wallet-viem to use GOAT wallets.",
    );
  }
}

/**
 * Wrap a viem `WalletClient` in GOAT's EVM wallet client, so GOAT plugins can
 * spend through the same signer the rest of a deployment uses.
 *
 * Refuses an account-less client here rather than at the first send: GOAT would
 * accept it and report an empty address.
 */
export async function createGoatWalletClient(client: WalletClient): Promise<GoatWalletClient> {
  if (!client.account?.address) {
    throw new Error(
      "GOAT wallet credentials missing — pass a viem WalletClient with an account. " +
        "GOAT accepts one without and reports an empty address instead of failing.",
    );
  }
  const { viem } = await loadGoatViem();
  return viem(client) as unknown as GoatWalletClient;
}
