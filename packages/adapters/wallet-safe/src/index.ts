/**
 * Safe smart-account wallet adapter (PRD F1.8).
 * Real connect / predict / deploy live in `./safe.js`; this module adapts them
 * to the shared `WalletAdapter` contract.
 *
 * As in the AgentKit adapter, every stubbed value is named `mock*` so a fake
 * address cannot be reached by accident.
 */

import {
  demoPolicyVerdict,
  withPolicyReader,
  type AdapterCheckInput,
  type PolicyReader,
  type WalletAdapter,
} from "@lacrew/adapter-wallet-agentkit";
import {
  connectSafeWallet,
  predictSafeWallet,
  type ConnectSafeWalletOptions,
  type PredictSafeWalletOptions,
  type SafeWallet,
} from "./safe.js";

export * from "./safe.js";
export * from "./allowance.js";
export * from "./execute.js";
export { demoPolicyVerdict };
export type { AdapterCheckInput, PolicyReader, WalletAdapter };

export interface MockSafeWallet {
  address: `0x${string}`;
  provider: "safe";
  threshold: number;
}

/** Mocked Safe handle — fixed address, no chain access. Demos and tests only. */
export async function createMockSafeWallet(
  owners: `0x${string}`[] = [],
): Promise<MockSafeWallet> {
  void owners;
  return {
    address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    provider: "safe",
    threshold: 1,
  };
}

/** Fully mocked adapter — mock address and mock verdicts. Never for funds. */
export const mockSafeWalletAdapter: WalletAdapter = {
  provider: "safe",
  async createWallet() {
    const w = await createMockSafeWallet();
    return { address: w.address, provider: w.provider };
  },
  checkPolicy: demoPolicyVerdict,
};

/** Mocked Safe addresses with real onchain verdicts. */
export function createMockSafeWalletAdapter(reader: PolicyReader): WalletAdapter {
  return withPolicyReader(mockSafeWalletAdapter, reader);
}

export type SafeWalletAdapterOptions = (
  | ConnectSafeWalletOptions
  | Omit<PredictSafeWalletOptions, "owners"> & { owners: `0x${string}`[] }
) & {
  /** Live policy module; without one `checkPolicy` refuses rather than guessing. */
  reader?: PolicyReader;
};

function isConnect(opts: SafeWalletAdapterOptions): opts is ConnectSafeWalletOptions & {
  reader?: PolicyReader;
} {
  return "safeAddress" in opts && typeof opts.safeAddress === "string";
}

/**
 * A `WalletAdapter` backed by a real Safe: connects to `safeAddress` when given
 * one, otherwise resolves the counterfactual address for the owner set.
 */
export function createSafeWalletAdapter(opts: SafeWalletAdapterOptions): WalletAdapter {
  return {
    provider: "safe",
    async createWallet(label?: string) {
      // The label distinguishes seats sharing an owner set, via the CREATE2 salt.
      const wallet: SafeWallet = isConnect(opts)
        ? await connectSafeWallet(opts)
        : await predictSafeWallet({ ...opts, saltNonce: opts.saltNonce ?? label });
      return { address: wallet.address, provider: wallet.provider };
    },
    checkPolicy: (input) => {
      if (!opts.reader) {
        throw new Error(
          "No PolicyReader bound — pass `reader` to createSafeWalletAdapter() so verdicts come from the onchain PolicyStack.",
        );
      }
      return opts.reader.checkPolicy(input);
    },
  };
}
