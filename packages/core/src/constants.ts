/** Protocol constants and deployment address resolution. */

import type { ChainAddresses } from "./types.js";
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
  humanRoot: "LACREW_HUMAN_ROOT",
  manager: "LACREW_MANAGER",
  worker: "LACREW_WORKER",
  x402Target: "LACREW_X402_TARGET",
} as const satisfies Record<Exclude<keyof ChainAddresses, "chainId">, string>;

/**
 * Resolve contract addresses for a chain.
 * Precedence: env overrides (every field, see ADDRESS_ENV_VARS) →
 * packages/core/deployments → placeholders. A local deployment (e.g. a
 * long-lived Anvil whose nonces diverge from the committed JSON) can be
 * fully described in .env without touching tracked files.
 */
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
    [Exclude<keyof ChainAddresses, "chainId">, string]
  >) {
    const override = envAddress(envVar);
    if (!override) continue;
    warnOnDivergence(chainId, field, envVar, override, base[field]);
    resolved[field] = override;
  }
  return resolved;
}

/** Ethereum Sepolia — first public testnet. */
export const SEPOLIA_CHAIN_ID = 11155111;

/** Optional later Base Sepolia slot. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Anvil / Foundry default chain. */
export const ANVIL_CHAIN_ID = 31337;
