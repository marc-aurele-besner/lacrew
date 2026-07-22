/**
 * Fixtures for the in-memory test client.
 *
 * These describe an organisation that does not exist. They live under
 * `@lacrew/sdk/testing` so they cannot be reached from production code by
 * accident — importing them anywhere but a test is a bug, because every number
 * here is invented.
 *
 * They were previously exported from `@lacrew/core`'s package root, which meant
 * any consumer could pull a fabricated org, allowance or audit trail into a
 * real code path with a plausible-looking import.
 */

import {
  MOCK_MANAGER,
  MOCK_ROOT,
  MOCK_TOKEN,
  MOCK_WORKER,
  type Allowance,
  type Intent,
  type OrgNode,
  type ProtocolEvent,
  type SessionKey,
} from "@lacrew/core";

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
    simulation: {
      status: "warning",
      gasEstimate: "142,310",
      assetChanges: [{ asset: "USDC", delta: "-75.00", direction: "out" }],
      warnings: ["Spend requires manager/root approval (cap or whitelist escalation)."],
    },
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

/**
 * Mocked audit trail for the offline demo org. Live deployments read
 * indexed chain events from Postgres (orchestrator_audit_events, F1.11).
 */
export const mockAuditTrail: ProtocolEvent[] = [
  {
    type: "AllowanceStreamed",
    at: "2026-07-17T12:00:00.000Z",
    payload: {
      node: "0x3333333333333333333333333333333333333333",
      amount: "50000000",
      epoch: 1,
    },
  },
  {
    type: "SessionIssued",
    at: "2026-07-17T12:05:00.000Z",
    payload: {
      agent: "0x3333333333333333333333333333333333333333",
      keyId: "sess_mock_worker_1",
      expiresAt: "2026-07-17T14:05:00.000Z",
    },
  },
  {
    type: "IntentCreated",
    at: "2026-07-17T12:10:00.000Z",
    payload: {
      intentId: "intent-mock-1",
      agent: "0x3333333333333333333333333333333333333333",
      awaitingApprover: "0x2222222222222222222222222222222222222222",
      value: "75000000",
    },
  },
];
