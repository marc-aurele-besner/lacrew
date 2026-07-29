/** Protocol constants and deployment address resolution. */

import type { AssetStack, ChainAddresses } from "./types.js";
import { DEPLOYMENTS } from "./deployments.generated.js";

export const PROTOCOL_NAME = "LaCrew";
export const PROTOCOL_VERSION = "0.0.0";

/** Synthetic token sentinel used by mocked treasury balances. */
export const MOCK_TOKEN = "0x0000000000000000000000000000000000000000" as const;

export const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * Read an address override.
 * A set-but-malformed value throws: silently falling back to the deployment
 * JSON would point callers at a different org than the operator intended.
 */
function envAddress(key: string): `0x${string}` | undefined {
  const raw =
    typeof process !== "undefined" && process.env ? process.env[key] : undefined;
  if (raw === undefined) return undefined;

  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error(
      `${key} is not a 20-byte hex address: ${JSON.stringify(raw)}. ` +
        `Unset it or fix the value — a malformed override must not silently fall back.`,
    );
  }
  return trimmed as `0x${string}`;
}

/** Warn once per (chain, field) when an override disagrees with the deployment JSON. */
const divergenceWarned = new Set<string>();

function warnOnDivergence(
  chainId: number,
  field: string,
  envVar: string,
  override: `0x${string}`,
  fromDeployment: `0x${string}` | undefined,
): void {
  if (!fromDeployment || fromDeployment === ZERO) return;
  if (override.toLowerCase() === fromDeployment.toLowerCase()) return;

  const seen = `${chainId}:${field}`;
  if (divergenceWarned.has(seen)) return;
  divergenceWarned.add(seen);

  console.warn(
    `[lacrew] ${envVar} (${override}) overrides the chain ${chainId} deployment ` +
      `(${fromDeployment}). Processes that do not load .env will resolve the deployment ` +
      `address instead — regenerate with: pnpm --filter @lacrew/core addresses:env ${chainId}`,
  );
}

/** Env var name per overridable ChainAddresses field (LACREW_<SNAKE_CASE>). */
export const ADDRESS_ENV_VARS = {
  orgRegistry: "LACREW_ORG_REGISTRY",
  treasury: "LACREW_TREASURY",
  escalationRouter: "LACREW_ESCALATION_ROUTER",
  governanceModule: "LACREW_GOVERNANCE_MODULE",
  spendCapPolicy: "LACREW_SPEND_CAP_POLICY",
  mockUSDC: "LACREW_MOCK_USDC",
  policyStack: "LACREW_POLICY_STACK",
  managerPolicyStack: "LACREW_MANAGER_POLICY_STACK",
  whitelistPolicy: "LACREW_WHITELIST_POLICY",
  timeWindowPolicy: "LACREW_TIME_WINDOW_POLICY",
  epochStreamer: "LACREW_EPOCH_STREAMER",
  sessionRegistry: "LACREW_SESSION_REGISTRY",
  marketplacePayments: "LACREW_MARKETPLACE_PAYMENTS",
  humanRoot: "LACREW_HUMAN_ROOT",
  manager: "LACREW_MANAGER",
  worker: "LACREW_WORKER",
  x402Target: "LACREW_X402_TARGET",
} as const satisfies Record<
  Exclude<keyof ChainAddresses, "chainId" | "assets">,
  string
>;

/**
 * Resolve contract addresses for a chain.
 * Precedence: env overrides (every field, see ADDRESS_ENV_VARS) →
 * packages/core/deployments → placeholders. A local deployment (e.g. a
 * long-lived Anvil whose nonces diverge from the committed JSON) can be
 * fully described in .env without touching tracked files.
 */
/**
 * Whether this chain has a real deployment, as opposed to the zero-address
 * shape `getAddresses` falls back to.
 *
 * Worth asking before constructing a client. Sepolia and Base Sepolia used to
 * ship committed address books full of `0x…01`–`0x…07`, which look like
 * deployments, satisfy every type, and produce a runtime whose reads all revert
 * — an org that renders as "empty" rather than as "not deployed". Those entries
 * are gone; this is how a caller tells the difference now.
 *
 * An env override counts: a fully described local deployment is a deployment.
 */
export function hasDeployment(chainId: number): boolean {
  if (DEPLOYMENTS[chainId]) return true;
  return Boolean(envAddress(ADDRESS_ENV_VARS.orgRegistry));
}

export function getAddresses(chainId: number): ChainAddresses {
  const base = DEPLOYMENTS[chainId] ?? {
    chainId,
    orgRegistry: ZERO,
    treasury: ZERO,
    escalationRouter: ZERO,
    governanceModule: ZERO,
    spendCapPolicy: ZERO,
  };

  const resolved: ChainAddresses = { ...base, chainId };
  for (const [field, envVar] of Object.entries(ADDRESS_ENV_VARS) as Array<
    [Exclude<keyof ChainAddresses, "chainId" | "assets">, string]
  >) {
    const override = envAddress(envVar);
    if (!override) continue;
    warnOnDivergence(chainId, field, envVar, override, base[field]);
    resolved[field] = override;
  }
  return resolved;
}

/** USDC is 6 decimals on every chain; the reference deploy's primary asset. */
export const PRIMARY_ASSET_SYMBOL = "USDC";
export const PRIMARY_ASSET_DECIMALS = 6;

/**
 * The primary asset stack — the flat `treasury` / `escalationRouter` /
 * `epochStreamer` fields, which the reference deploy denominates in USDC.
 * `epochStreamer` may be absent on a bare address book; the stack then carries
 * the zero address for it, the same fallback `getAllowances`/`runEpoch` apply.
 */
export function primaryAssetStack(addresses: ChainAddresses): AssetStack {
  return {
    symbol: PRIMARY_ASSET_SYMBOL,
    token: addresses.mockUSDC ?? ZERO,
    decimals: PRIMARY_ASSET_DECIMALS,
    treasury: addresses.treasury,
    escalationRouter: addresses.escalationRouter,
    epochStreamer: addresses.epochStreamer ?? ZERO,
    spendCapPolicy: addresses.spendCapPolicy,
    whitelistPolicy: addresses.whitelistPolicy,
    policyStack: addresses.policyStack,
  };
}

/** Every asset stack for a chain: the primary (flat fields) first, then extras. */
export function listAssetStacks(addresses: ChainAddresses): AssetStack[] {
  return [primaryAssetStack(addresses), ...(addresses.assets ?? [])];
}

/**
 * Resolve one asset's enforcement stack.
 *
 * Omit `selector` for the primary (USDC) stack. Otherwise match by symbol
 * (case-insensitive) or token address, throwing when none matches — silently
 * falling back to the primary would budget or read the wrong asset's treasury.
 */
export function resolveAssetStack(
  addresses: ChainAddresses,
  selector?: string,
): AssetStack {
  if (selector === undefined || selector === "") {
    return primaryAssetStack(addresses);
  }
  const stacks = listAssetStacks(addresses);
  const needle = selector.toLowerCase();
  const match = stacks.find(
    (s) => s.symbol.toLowerCase() === needle || s.token.toLowerCase() === needle,
  );
  if (!match) {
    const known = stacks.map((s) => s.symbol).join(", ");
    throw new Error(
      `No asset stack "${selector}" on chain ${addresses.chainId}. Known assets: ${known}.`,
    );
  }
  return match;
}

/** Ethereum Sepolia — first public testnet. */
export const SEPOLIA_CHAIN_ID = 11155111;

/** Optional later Base Sepolia slot. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Anvil / Foundry default chain. */
export const ANVIL_CHAIN_ID = 31337;

/** Base mainnet — the Phase 1 target (F1.4), gated on the audit. */
export const BASE_CHAIN_ID = 8453;

/** Ethereum mainnet. */
export const MAINNET_CHAIN_ID = 1;

/** Arbitrum One. */
export const ARBITRUM_CHAIN_ID = 42161;

/** OP Mainnet. */
export const OPTIMISM_CHAIN_ID = 10;

/** Polygon PoS — settles in POL, not ether. */
export const POLYGON_CHAIN_ID = 137;

/**
 * Display metadata for the chains this repo can name. Nothing onchain names a
 * chain or its coin, so this table is the only place either string can come
 * from — which is also why it is kept here, in the public package, where the
 * claim can be checked rather than in cloud code nobody can read.
 *
 * Membership here says only "we can name this chain". It says nothing about a
 * LaCrew deployment existing on it: reading what an account holds needs an RPC,
 * the account address, and a token address — no protocol contracts at all.
 */
const CHAIN_METADATA: Record<number, { name: string; nativeSymbol: string }> = {
  [ANVIL_CHAIN_ID]: { name: "Anvil (local)", nativeSymbol: "ETH" },
  [MAINNET_CHAIN_ID]: { name: "Ethereum", nativeSymbol: "ETH" },
  [SEPOLIA_CHAIN_ID]: { name: "Ethereum Sepolia", nativeSymbol: "ETH" },
  [BASE_CHAIN_ID]: { name: "Base", nativeSymbol: "ETH" },
  [BASE_SEPOLIA_CHAIN_ID]: { name: "Base Sepolia", nativeSymbol: "ETH" },
  [ARBITRUM_CHAIN_ID]: { name: "Arbitrum One", nativeSymbol: "ETH" },
  [OPTIMISM_CHAIN_ID]: { name: "OP Mainnet", nativeSymbol: "ETH" },
  // Polygon's coin is POL, not ether. The whole reason `nativeSymbol` is not
  // defaulted anywhere is so this row can be different without special-casing.
  [POLYGON_CHAIN_ID]: { name: "Polygon", nativeSymbol: "POL" },
};

/**
 * Well-known stablecoins per chain, offered as a pick-list so an operator does
 * not have to paste contract addresses by hand.
 *
 * **These are reference data, not protocol state.** A wrong address here does
 * not move money — `balanceOf` on the wrong contract simply reads zero — but a
 * silent zero is exactly the failure this surface exists to prevent, so every
 * address is shown in the UI beside its symbol and any of them can be
 * overridden. Verify against the issuer before relying on a mainnet figure.
 *
 * Only assets whose issuer publishes a canonical deployment are listed. Bridged
 * variants (USDC.e and friends) are deliberately absent: they share a ticker
 * with the native asset and listing both under one symbol is how a balance ends
 * up attributed to the wrong token.
 */
export const KNOWN_STABLECOINS: Record<
  number,
  ReadonlyArray<{ symbol: string; address: `0x${string}`; decimals: number }>
> = {
  [MAINNET_CHAIN_ID]: [
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  ],
  [BASE_CHAIN_ID]: [
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
    { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  ],
  [BASE_SEPOLIA_CHAIN_ID]: [
    { symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
  ],
  [SEPOLIA_CHAIN_ID]: [
    { symbol: "USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
  ],
  [ARBITRUM_CHAIN_ID]: [
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18 },
  ],
  [OPTIMISM_CHAIN_ID]: [
    { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
    { symbol: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
    { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18 },
  ],
  [POLYGON_CHAIN_ID]: [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
  ],
};

/**
 * A public endpoint per chain, used when the operator has configured none.
 *
 * Chain-operator endpoints are preferred over third-party aggregators: they are
 * the most verifiable and the least likely to quietly disappear. Anvil has none
 * on purpose — it is local, and defaulting a hosted orchestrator to
 * `127.0.0.1` would have it dial itself and report someone else's chain.
 *
 * These are shared and rate-limited. A throttled read surfaces as a chain that
 * could not be read, which is the truthful outcome, but it is also why the
 * surface says *which* endpoint answered: "sometimes unread" is confusing until
 * you know you are on a shared endpoint.
 *
 * They are also not private. Reading balances tells whoever runs the endpoint
 * which addresses an operator cares about; configuring your own avoids that.
 */
const PUBLIC_RPC_URLS: Record<number, string> = {
  [MAINNET_CHAIN_ID]: "https://ethereum-rpc.publicnode.com",
  [SEPOLIA_CHAIN_ID]: "https://ethereum-sepolia-rpc.publicnode.com",
  [BASE_CHAIN_ID]: "https://mainnet.base.org",
  [BASE_SEPOLIA_CHAIN_ID]: "https://sepolia.base.org",
  [ARBITRUM_CHAIN_ID]: "https://arb1.arbitrum.io/rpc",
  [OPTIMISM_CHAIN_ID]: "https://mainnet.optimism.io",
  [POLYGON_CHAIN_ID]: "https://polygon-rpc.com",
};

/** The public fallback endpoint for a chain, or null when there is none. */
export function publicRpcUrl(chainId: number): string | null {
  return PUBLIC_RPC_URLS[chainId] ?? null;
}

/** Every chain this package can name, for a settings pick-list. */
export function knownChains(): Array<{
  chainId: number;
  name: string;
  nativeSymbol: string;
  stablecoins: ReadonlyArray<{ symbol: string; address: `0x${string}`; decimals: number }>;
  /** Fallback endpoint used when the operator configures none; null if there is none. */
  publicRpc: string | null;
}> {
  return Object.entries(CHAIN_METADATA).map(([id, meta]) => ({
    chainId: Number(id),
    name: meta.name,
    nativeSymbol: meta.nativeSymbol,
    stablecoins: KNOWN_STABLECOINS[Number(id)] ?? [],
    publicRpc: publicRpcUrl(Number(id)),
  }));
}

/**
 * Name and coin symbol for a chain, or nulls when the id is not one we know.
 *
 * Deliberately not defaulted to ether: EVM chains do not share a coin, and a
 * balance rendered "0.42 ETH" on a chain settling in something else is a wrong
 * number wearing a confident label. A null symbol lets a caller show the figure
 * and say it cannot name the unit.
 */
export function chainMetadata(chainId: number): {
  name: string | null;
  nativeSymbol: string | null;
} {
  const meta = CHAIN_METADATA[chainId];
  return { name: meta?.name ?? null, nativeSymbol: meta?.nativeSymbol ?? null };
}
