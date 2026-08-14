/**
 * Which wallet provider a deployment runs its agent seats on (PRD F1.8 / F3.3).
 *
 * The providers are peers — CDP, Safe, MetaMask and GOAT all implement the same
 * `WalletAdapter`, and nothing in this repo's feature code names one of them. So
 * the choice is an operator's, made once in the environment:
 *
 *     LACREW_WALLET_ADAPTER=goat
 *
 * A name this file does not know is a boot error, not a fallback. The same rule
 * `LACREW_DELEGATIONS` follows in runtime.ts, and for the same reason: an
 * unrecognised provider silently becoming the default would move real funds
 * through a wallet the operator did not pick.
 *
 * The adapter package itself is loaded only when its id is selected, so a
 * deployment on Safe never pays for GOAT's optional peer, or vice versa.
 */

import type { WalletAdapter } from "@lacrew/adapter-wallet-agentkit";

export const WALLET_ADAPTER_IDS = ["agentkit", "safe", "metamask", "goat"] as const;

export type WalletAdapterId = (typeof WALLET_ADAPTER_IDS)[number];

/**
 * Provider-specific options, plus the `reader` every adapter takes. Each
 * factory validates its own shape — see the adapter's `create*WalletAdapter`.
 */
export type WalletAdapterOptions = Record<string, unknown>;

export type WalletAdapterFactory = (options: WalletAdapterOptions) => WalletAdapter;

function isWalletAdapterId(value: string): value is WalletAdapterId {
  return (WALLET_ADAPTER_IDS as readonly string[]).includes(value);
}

/** Parse a configured provider id, naming the supported set when it is wrong. */
export function parseWalletAdapterId(raw: string): WalletAdapterId {
  const id = raw.trim();
  if (!isWalletAdapterId(id)) {
    throw new Error(
      `Unknown LACREW_WALLET_ADAPTER "${raw}" (supported: ${WALLET_ADAPTER_IDS.join(", ")}).`,
    );
  }
  return id;
}

/** The configured provider, or undefined when the deployment sets none. */
export function walletAdapterIdFromEnv(
  env: Record<string, string | undefined> = process.env,
): WalletAdapterId | undefined {
  const raw = env.LACREW_WALLET_ADAPTER;
  if (!raw || raw.trim() === "") return undefined;
  return parseWalletAdapterId(raw);
}

const LOADERS: Record<WalletAdapterId, () => Promise<WalletAdapterFactory>> = {
  agentkit: async () => {
    const { createCdpWalletAdapter } = await import("@lacrew/adapter-wallet-agentkit");
    return createCdpWalletAdapter as unknown as WalletAdapterFactory;
  },
  safe: async () => {
    const { createSafeWalletAdapter } = await import("@lacrew/adapter-wallet-safe");
    return createSafeWalletAdapter as unknown as WalletAdapterFactory;
  },
  metamask: async () => {
    const { createMetaMaskWalletAdapter } = await import("@lacrew/adapter-wallet-metamask");
    return createMetaMaskWalletAdapter as unknown as WalletAdapterFactory;
  },
  goat: async () => {
    const { createGoatWalletAdapter } = await import("@lacrew/adapter-wallet-goat");
    return createGoatWalletAdapter as unknown as WalletAdapterFactory;
  },
};

/** Load the selected provider's adapter factory. */
export async function resolveWalletAdapterFactory(
  id: WalletAdapterId,
): Promise<WalletAdapterFactory> {
  return LOADERS[id]();
}

/**
 * Build the configured adapter. Returns undefined when no provider is selected
 * — a deployment that never provisions seat wallets is a valid configuration,
 * whereas a misspelled one is not.
 */
export async function walletAdapterFromEnv(
  options: WalletAdapterOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<WalletAdapter | undefined> {
  const id = walletAdapterIdFromEnv(env);
  if (!id) return undefined;
  const factory = await resolveWalletAdapterFactory(id);
  return factory(options);
}
