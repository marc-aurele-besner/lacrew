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
