/**
 * MetaMask smart accounts as agent seat wallets (PRD F1.8 / F3.3).
 *
 * `@metamask/smart-accounts-kit` is an optional peer, loaded only when a caller
 * actually provisions an account — the same shape as the CDP and Safe adapters.
 *
 * The account is counterfactual until deployed, so its address can be funded
 * before it exists, and deployment is a plain transaction: no ERC-4337 bundler
 * is required anywhere in this adapter.
 */

import type { Address } from "viem";

/** Chains the kit ships a delegation environment for, as used here. */
export const SUPPORTED_CHAIN_IDS = [8453, 84532] as const;

export type MetaMaskWallet = {
  address: `0x${string}`;
  provider: "metamask";
  /** False while the account is still counterfactual. */
  deployed: boolean;
};

export type MetaTransaction = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
};

/** Minimal viem PublicClient surface the kit needs. */
export type PublicClientLike = {
  getChainId: () => Promise<number>;
  getCode: (args: { address: Address }) => Promise<`0x${string}` | undefined>;
};

async function loadKit() {
  try {
    return await import("@metamask/smart-accounts-kit");
  } catch {
    throw new Error(
      "@metamask/smart-accounts-kit is not installed — pnpm add @metamask/smart-accounts-kit to use MetaMask wallets.",
    );
  }
}

/**
 * Delegation environment (DelegationManager, factory, caveat enforcers) for a
 * chain, with a clear error instead of a silent undefined.
 */
export async function getEnvironment(chainId: number): Promise<Record<string, unknown>> {
  const kit = await loadKit();
  try {
    return kit.getSmartAccountsEnvironment(chainId) as unknown as Record<string, unknown>;
  } catch {
    throw new Error(
      `MetaMask smart accounts are not deployed on chain ${chainId}. ` +
        `Known chains here: ${SUPPORTED_CHAIN_IDS.join(", ")}.`,
    );
  }
}

/** Address of the DelegationManager a redemption must be sent to. */
export async function getDelegationManagerAddress(
  chainId: number,
): Promise<`0x${string}`> {
  const env = await getEnvironment(chainId);
  const address = env.DelegationManager as `0x${string}` | undefined;
  if (!address) {
    throw new Error(`No DelegationManager in the environment for chain ${chainId}.`);
  }
  return address;
}

/** Signer the smart account is owned by — a viem Account or WalletClient. */
export type OwnerSigner = { address: `0x${string}` } & Record<string, unknown>;

export type CreateMetaMaskWalletOptions = {
  client: PublicClientLike;
  /** Owner key controlling the seat wallet. */
  owner: OwnerSigner;
  /**
   * Distinguishes seats sharing an owner. Any string works: non-numeric labels
   * are hashed to a salt, so a readable seat name yields a stable address.
   */
  salt?: string;
};

/** FNV-1a over the label, so a readable seat name maps to a deterministic salt. */
function toSalt(label: string): `0x${string}` {
  if (/^0x[0-9a-fA-F]{64}$/.test(label)) return label as `0x${string}`;
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < label.length; i++) {
    hash = (hash ^ BigInt(label.charCodeAt(i))) & mask;
    hash = (hash * 0x100000001b3n) & mask;
  }
  return `0x${hash.toString(16).padStart(64, "0")}`;
}

/** Opaque handle to the kit's smart account, kept out of the public types. */
export type MetaMaskSmartAccount = {
  address: `0x${string}`;
  isDeployed: () => Promise<boolean>;
  getFactoryArgs: () => Promise<{ factory?: Address; factoryData?: `0x${string}` }>;
  signDelegation: (args: { delegation: unknown }) => Promise<`0x${string}`>;
};

/**
 * Resolve the seat's smart account. Deterministic in (owner, salt), so calling
 * it again returns the same address rather than provisioning a second wallet.
 */
export async function getMetaMaskSmartAccount(
  opts: CreateMetaMaskWalletOptions,
): Promise<MetaMaskSmartAccount> {
  const kit = await loadKit();
  const chainId = await opts.client.getChainId();
  await getEnvironment(chainId);
  return (await kit.toMetaMaskSmartAccount({
    client: opts.client as never,
    implementation: kit.Implementation.Hybrid,
    // Hybrid takes (owner, passkeyIds, passkeyX, passkeyY); no passkeys here.
    deployParams: [opts.owner.address, [], [], []],
    deploySalt: toSalt(opts.salt ?? "lacrew-seat"),
    signer: { account: opts.owner } as never,
  })) as unknown as MetaMaskSmartAccount;
}

/** Seat wallet handle, including whether it exists onchain yet. */
export async function createMetaMaskWallet(
  opts: CreateMetaMaskWalletOptions,
): Promise<MetaMaskWallet> {
  const account = await getMetaMaskSmartAccount(opts);
  return {
    address: account.address,
    provider: "metamask",
    deployed: await account.isDeployed(),
  };
}

/**
 * Deployment transaction for a counterfactual seat wallet. Returned rather than
 * broadcast — this package holds no key material — and it is an ordinary
 * transaction, so anyone can pay for it.
 *
 * A delegation cannot be redeemed until the account exists: the DelegationManager
 * reverts with `InvalidEOASignature()` against undeployed code.
 */
export async function buildAccountDeploymentTx(
  opts: CreateMetaMaskWalletOptions,
): Promise<MetaTransaction | null> {
  const account = await getMetaMaskSmartAccount(opts);
  if (await account.isDeployed()) return null;
  const { factory, factoryData } = await account.getFactoryArgs();
  if (!factory || !factoryData) {
    throw new Error("The kit returned no factory args for an undeployed account.");
  }
  return { to: factory as `0x${string}`, data: factoryData, value: 0n };
}
