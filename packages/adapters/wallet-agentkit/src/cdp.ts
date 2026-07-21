/**
 * Real Coinbase CDP wallet provisioning (PRD F1.8).
 *
 * `@coinbase/cdp-sdk` is an optional peer: the dependency only loads when a
 * caller actually provisions a wallet, so the policy surface stays importable
 * in environments that never touch CDP.
 *
 * Default shape is a smart account owned by a CDP server account — that is the
 * form allowances and x402 payments need, since a funded smart account is what
 * the Treasury streams into.
 */

import type { PolicyReader, WalletAdapter } from "./index.js";

export type CdpCredentials = {
  /** Defaults to CDP_API_KEY_ID. */
  apiKeyId?: string;
  /** Defaults to CDP_API_KEY_SECRET. */
  apiKeySecret?: string;
  /** Defaults to CDP_WALLET_SECRET; required for account creation (POST). */
  walletSecret?: string;
  /** Override the API host — used by tests to target a local server. */
  basePath?: string;
};

export type CdpWalletOptions = CdpCredentials & {
  /**
   * Stable name CDP keys the account off. Reusing a name returns the existing
   * account, so provisioning is idempotent per agent seat.
   */
  name: string;
  /**
   * Smart account (default) vs. plain server account (EOA). Smart accounts are
   * required for spend permissions and x402.
   */
  smartAccount?: boolean;
  /** Enable CDP spend permissions on the smart account. Default true. */
  enableSpendPermissions?: boolean;
};

export type CdpWallet = {
  address: `0x${string}`;
  provider: "agentkit";
  /** Owner EOA address; equals `address` for a plain server account. */
  ownerAddress: `0x${string}`;
  kind: "smart" | "server";
  name: string;
};

/** Credentials resolved from explicit options first, then the CDP env vars. */
function resolveCredentials(opts: CdpCredentials): Required<Omit<CdpCredentials, "basePath">> & {
  basePath?: string;
} {
  const apiKeyId = opts.apiKeyId ?? process.env.CDP_API_KEY_ID;
  const apiKeySecret = opts.apiKeySecret ?? process.env.CDP_API_KEY_SECRET;
  const walletSecret = opts.walletSecret ?? process.env.CDP_WALLET_SECRET;
  const missing = [
    !apiKeyId && "CDP_API_KEY_ID",
    !apiKeySecret && "CDP_API_KEY_SECRET",
    !walletSecret && "CDP_WALLET_SECRET",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `CDP credentials missing: ${missing.join(", ")}. ` +
        "Set them in the environment or pass them to createCdpWallet(). " +
        "Create keys at https://portal.cdp.coinbase.com/projects/api-keys.",
    );
  }
  return {
    apiKeyId: apiKeyId!,
    apiKeySecret: apiKeySecret!,
    walletSecret: walletSecret!,
    basePath: opts.basePath ?? process.env.CDP_API_BASE_PATH,
  };
}

/** Load the optional peer, surfacing install guidance instead of a module error. */
async function loadCdp(): Promise<typeof import("@coinbase/cdp-sdk")> {
  try {
    return await import("@coinbase/cdp-sdk");
  } catch {
    throw new Error(
      "@coinbase/cdp-sdk is not installed — pnpm add @coinbase/cdp-sdk to provision CDP wallets.",
    );
  }
}

/**
 * Provision (or fetch) a real CDP wallet. Idempotent per `name`: CDP returns
 * the existing account rather than minting a second one for the same seat.
 */
export async function createCdpWallet(opts: CdpWalletOptions): Promise<CdpWallet> {
  const creds = resolveCredentials(opts);
  const { CdpClient } = await loadCdp();
  const cdp = new CdpClient({
    apiKeyId: creds.apiKeyId,
    apiKeySecret: creds.apiKeySecret,
    walletSecret: creds.walletSecret,
    ...(creds.basePath ? { basePath: creds.basePath } : {}),
  });

  const owner = await cdp.evm.getOrCreateAccount({ name: opts.name });
  if (opts.smartAccount === false) {
    return {
      address: owner.address,
      provider: "agentkit",
      ownerAddress: owner.address,
      kind: "server",
      name: opts.name,
    };
  }

  const smart = await cdp.evm.getOrCreateSmartAccount({
    name: opts.name,
    owner,
    enableSpendPermissions: opts.enableSpendPermissions ?? true,
  });
  return {
    address: smart.address,
    provider: "agentkit",
    ownerAddress: owner.address,
    kind: "smart",
    name: opts.name,
  };
}

export type CdpWalletAdapterOptions = Omit<CdpWalletOptions, "name"> & {
  /** Fallback name when `createWallet()` is called without a label. */
  name?: string;
  /** Live policy module; without one `checkPolicy` refuses rather than guessing. */
  reader?: PolicyReader;
};

/**
 * A `WalletAdapter` backed by real CDP provisioning. The `label` passed to
 * `createWallet()` becomes the CDP account name, so each agent seat maps to a
 * stable account.
 */
export function createCdpWalletAdapter(opts: CdpWalletAdapterOptions = {}): WalletAdapter {
  const { reader, name, ...cdpOpts } = opts;
  return {
    provider: "agentkit",
    async createWallet(label?: string) {
      const accountName = label ?? name;
      if (!accountName) {
        throw new Error(
          "createWallet() needs an account name — pass a label or set `name` on createCdpWalletAdapter().",
        );
      }
      const wallet = await createCdpWallet({ ...cdpOpts, name: accountName });
      return { address: wallet.address, provider: wallet.provider };
    },
    checkPolicy: (input) => {
      if (!reader) {
        throw new Error(
          "No PolicyReader bound — pass `reader` to createCdpWalletAdapter() so verdicts come from the onchain PolicyStack.",
        );
      }
      return reader.checkPolicy(input);
    },
  };
}
