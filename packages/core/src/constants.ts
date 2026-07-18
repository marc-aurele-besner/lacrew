/** Protocol constants and deployment address resolution. */

import type { ChainAddresses } from "./types.js";
import { DEPLOYMENTS } from "./deployments.generated.js";

export const PROTOCOL_NAME = "LaCrew";
export const PROTOCOL_VERSION = "0.0.0";

/** Synthetic token sentinel used by mocked treasury balances. */
export const MOCK_TOKEN = "0x0000000000000000000000000000000000000000" as const;

export const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

const ZERO = "0x0000000000000000000000000000000000000000" as const;

function envAddress(key: string): `0x${string}` | undefined {
  const raw =
    typeof process !== "undefined" && process.env ? process.env[key] : undefined;
  if (!raw || !/^0x[a-fA-F0-9]{40}$/.test(raw)) return undefined;
  return raw as `0x${string}`;
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
    if (override) resolved[field] = override;
  }
  return resolved;
}

/** Ethereum Sepolia — first public testnet. */
export const SEPOLIA_CHAIN_ID = 11155111;

/** @deprecated Prefer getAddresses(SEPOLIA_CHAIN_ID). Kept for older imports. */
export const SEPOLIA_ADDRESSES: ChainAddresses = getAddresses(SEPOLIA_CHAIN_ID);

/** @deprecated Prefer getAddresses(84532). Optional later Base Sepolia slot. */
export const BASE_SEPOLIA_ADDRESSES: ChainAddresses = getAddresses(84532);

/** Anvil / Foundry default chain. */
export const ANVIL_CHAIN_ID = 31337;
