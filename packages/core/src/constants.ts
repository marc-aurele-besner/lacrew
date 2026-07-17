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

/**
 * Resolve contract addresses for a chain.
 * Precedence: env overrides → packages/core/deployments → placeholders.
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

  return {
    ...base,
    chainId,
    orgRegistry: envAddress("LACREW_ORG_REGISTRY") ?? base.orgRegistry,
    treasury: envAddress("LACREW_TREASURY") ?? base.treasury,
    escalationRouter: envAddress("LACREW_ESCALATION_ROUTER") ?? base.escalationRouter,
    governanceModule: envAddress("LACREW_GOVERNANCE_MODULE") ?? base.governanceModule,
    spendCapPolicy: envAddress("LACREW_SPEND_CAP_POLICY") ?? base.spendCapPolicy,
    mockUSDC: envAddress("LACREW_MOCK_USDC") ?? base.mockUSDC,
    policyStack: envAddress("LACREW_POLICY_STACK") ?? base.policyStack,
    whitelistPolicy: envAddress("LACREW_WHITELIST_POLICY") ?? base.whitelistPolicy,
  };
}

/** @deprecated Prefer getAddresses(84532). Kept for older imports. */
export const BASE_SEPOLIA_ADDRESSES: ChainAddresses = getAddresses(84532);

/** Anvil / Foundry default chain. */
export const ANVIL_CHAIN_ID = 31337;
