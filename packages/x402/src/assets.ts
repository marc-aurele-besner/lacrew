/**
 * Known settlement assets (PRD F1.15).
 *
 * The EIP-712 domain name differs per deployment — Base mainnet USDC is
 * "USD Coin" while Base Sepolia is "USDC". Signing against the wrong one
 * produces a signature that fails onchain with no useful error, so these are
 * recorded from the deployed contracts rather than assumed.
 */

import type { PaymentRequirements, X402Network } from "./types.js";

export type KnownAsset = {
  address: `0x${string}`;
  decimals: number;
  /** EIP-712 domain name as reported by the contract. */
  name: string;
  /** EIP-712 domain version as reported by the contract. */
  version: string;
  chainId: number;
};

/** USDC per network, verified against the deployed contracts. */
export const USDC: Record<X402Network, KnownAsset> = {
  base: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    name: "USD Coin",
    version: "2",
    chainId: 8453,
  },
  "base-sepolia": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    name: "USDC",
    version: "2",
    chainId: 84532,
  },
};

export const CHAIN_IDS: Record<X402Network, number> = {
  base: 8453,
  "base-sepolia": 84532,
};

export function networkForChainId(chainId: number): X402Network {
  const match = (Object.keys(CHAIN_IDS) as X402Network[]).find(
    (n) => CHAIN_IDS[n] === chainId,
  );
  if (!match) throw new Error(`No x402 network configured for chain ${chainId}.`);
  return match;
}

export type CreateRequirementsOptions = {
  network: X402Network;
  payTo: `0x${string}`;
  /** Price in the token's smallest unit. */
  maxAmountRequired: bigint;
  resource: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  /** Defaults to the network's USDC. */
  asset?: KnownAsset;
};

/**
 * The `PaymentRequirements` a resource server returns with HTTP 402. The token
 * domain hints ride along so the client signs the right domain without an extra
 * round trip to the chain.
 */
export function createPaymentRequirements(
  opts: CreateRequirementsOptions,
): PaymentRequirements {
  const asset = opts.asset ?? USDC[opts.network];
  return {
    scheme: "exact",
    network: opts.network,
    asset: asset.address,
    maxAmountRequired: opts.maxAmountRequired.toString(),
    payTo: opts.payTo,
    resource: opts.resource,
    description: opts.description,
    mimeType: opts.mimeType,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 600,
    extra: { name: asset.name, version: asset.version },
  };
}
