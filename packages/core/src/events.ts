/** Off-chain shapes for protocol events (indexer / UI). */

export type ProtocolEventType =
  | "IntentCreated"
  | "IntentEscalated"
  | "IntentResolved"
  | "ActionExecuted"
  | "AllowanceStreamed"
  | "AllowanceSpent"
  | "ProposalCreated"
  | "ProposalVoted"
  | "ProposalVetoed"
  | "ProposalExecuted"
  | "SessionIssued"
  | "SessionRevoked";

export interface ProtocolEvent {
  type: ProtocolEventType;
  /** ISO timestamp; Mocked sources invent these. */
  at: string;
  orgId?: string;
  payload: Record<string, unknown>;
}

/**
 * Mocked audit trail for the demo org.
 * TODO: Replace with Ponder-indexed chain events.
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
