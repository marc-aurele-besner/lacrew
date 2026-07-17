/**
 * Mocked demo organization used by SDK, CLI, and cloud until chain reads land.
 * TODO: Replace loaders with viem reads against OrgRegistry + Treasury.
 */

import { MOCK_TOKEN } from "../constants.js";
import type { Allowance, Intent, OrgNode, SessionKey } from "../types.js";

export const MOCK_ROOT = "0x1111111111111111111111111111111111111111" as const;
export const MOCK_MANAGER = "0x2222222222222222222222222222222222222222" as const;
export const MOCK_WORKER = "0x3333333333333333333333333333333333333333" as const;

export const mockOrgNodes: OrgNode[] = [
  {
    account: MOCK_ROOT,
    kind: "human_root",
    parent: null,
    active: true,
    label: "Human Root",
  },
  {
    account: MOCK_MANAGER,
    kind: "manager_agent",
    parent: MOCK_ROOT,
    active: true,
    label: "Manager A",
  },
  {
    account: MOCK_WORKER,
    kind: "worker_agent",
    parent: MOCK_MANAGER,
    active: true,
    label: "Worker 1",
  },
];

export const mockAllowances: Allowance[] = [
  {
    node: MOCK_MANAGER,
    token: MOCK_TOKEN,
    balance: 200n * 10n ** 6n,
    epoch: 1,
    cap: 200n * 10n ** 6n,
  },
  {
    node: MOCK_WORKER,
    token: MOCK_TOKEN,
    balance: 50n * 10n ** 6n,
    epoch: 1,
    cap: 50n * 10n ** 6n,
  },
];

export const mockPendingIntents: Intent[] = [
  {
    id: "intent-mock-1",
    agent: MOCK_WORKER,
    target: "0x4444444444444444444444444444444444444444",
    value: 75n * 10n ** 6n,
    data: "0x",
    awaitingApprover: MOCK_MANAGER,
    resolved: false,
    approved: null,
    verdict: "ESCALATE",
  },
];

export const mockSessionKeys: SessionKey[] = [
  {
    agent: MOCK_WORKER,
    keyId: "sess_mock_worker_1",
    expiresAt: Date.now() + 2 * 60 * 60 * 1000,
    scopes: ["spend:whitelist", "propose:intent"],
  },
];
