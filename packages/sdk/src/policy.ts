/**
 * Client-side policy preflight mirroring onchain IPolicyModule stacking.
 * Mocked: local whitelist + spend cap only.
 * TODO: Read live module config from chain / indexer.
 */

import type { Verdict } from "@lacrew/core";

export interface ClientPolicyConfig {
  /** Targets that pass the whitelist module. */
  whitelist: `0x${string}`[];
  /** Per-agent spend caps (synthetic units). Keys compared case-insensitively. */
  caps: Record<string, bigint>;
}

export const defaultMockPolicy: ClientPolicyConfig = {
  whitelist: ["0x4444444444444444444444444444444444444444"],
  caps: {
    // Worker / manager / root caps (synthetic USDC units).
    "0x3333333333333333333333333333333333333333": 50n * 10n ** 6n,
    "0x2222222222222222222222222222222222222222": 200n * 10n ** 6n,
    "0x1111111111111111111111111111111111111111": 10n ** 18n,
  },
};

function resolveCap(config: ClientPolicyConfig, agent: string): bigint {
  const hit = Object.entries(config.caps).find(
    ([key]) => key.toLowerCase() === agent.toLowerCase(),
  );
  return hit?.[1] ?? 0n;
}

export function checkClientPolicy(
  config: ClientPolicyConfig,
  input: { agent: `0x${string}`; target: `0x${string}`; value: bigint },
): Verdict {
  const allowed = config.whitelist.some(
    (t) => t.toLowerCase() === input.target.toLowerCase(),
  );
  if (!allowed) return "DENY";

  const cap = resolveCap(config, input.agent);
  if (input.value <= cap) return "ALLOW";
  return "ESCALATE";
}
