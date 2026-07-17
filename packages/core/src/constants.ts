/** Protocol constants and placeholder deployment addresses. */

import type { ChainAddresses } from "./types.js";

export const PROTOCOL_NAME = "LaCrew";
export const PROTOCOL_VERSION = "0.0.0";

/** Base Sepolia — Mocked placeholders until DeployMockOrg is run. */
// TODO: Replace with addresses from a real Base Sepolia deploy.
export const BASE_SEPOLIA_ADDRESSES: ChainAddresses = {
  chainId: 84532,
  orgRegistry: "0x0000000000000000000000000000000000000001",
  treasury: "0x0000000000000000000000000000000000000002",
  escalationRouter: "0x0000000000000000000000000000000000000003",
  governanceModule: "0x0000000000000000000000000000000000000004",
  spendCapPolicy: "0x0000000000000000000000000000000000000005",
};

/** Synthetic token sentinel used by mocked treasury balances. */
export const MOCK_TOKEN = "0x0000000000000000000000000000000000000000" as const;

export const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
