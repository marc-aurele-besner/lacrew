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
  | "ProposalDefeated"
  | "SessionIssued"
  | "SessionRevoked"
  /**
   * Account-level session delegations (F1.3). Issue/disable are orchestrator
   * actions with onchain receipts; the two *Failed kinds record that the
   * account-level path did NOT change — "no delegation" must never be
   * mistaken for "delegation issued", nor a failed disable for a dead one.
   */
  | "SessionDelegationIssued"
  | "SessionDelegationFailed"
  | "SessionDelegationDisabled"
  | "SessionDelegationDisableFailed"
  /**
   * An ERC-20 transfer INTO an asset stack's Treasury — money arriving. The
   * contract emits nothing for a plain transfer, so the indexer derives this
   * from the token's own Transfer log filtered to the treasury address.
   */
  | "TreasuryDeposit"
  /**
   * An ERC-20 transfer OUT of an asset stack's Treasury, derived the same
   * way. A legitimate spend shares its txHash with an ActionExecuted /
   * AllowanceSpent event; an outflow matching no spend is the strongest
   * theft signal the trail can carry (Guardian correlates them).
   */
  | "TreasuryOutflow"
  | "FlowSaved"
  | "FlowRun"
  /**
   * A flow reached outside LaCrew through an operator-registered connector.
   * Carries what was called and how it went — connector, route, method,
   * effect, status, duration — and never the response body or the credential.
   * A `write` effect here is a crew acting on the world, so this is the row an
   * operator scans when asking what their agents actually did.
   */
  | "ToolCalled"
  | "MarketplacePurchase"
  | "MarketplaceListed"
  | "MarketplaceWithdrawn"
  /**
   * An operator stopped or restarted an agent at the orchestrator (F1.7).
   *
   * Off-chain, like `FlowRun` and `ToolCalled`: a pause gates session issuance
   * and revokes live keys, but changes nothing the chain knows about — the
   * agent keeps its seat, its grant, and its policy stack. The revocations it
   * performs emit their own `SessionRevoked` rows, so the onchain-visible half
   * of a pause is recorded where it always was; these two say who decided it
   * and why, which is the part no other row carries.
   */
  | "AgentPaused"
  | "AgentResumed";

export interface ProtocolEvent {
  type: ProtocolEventType;
  /** ISO timestamp; Mocked sources invent these. */
  at: string;
  /**
   * Where `at` came from. `"block"` is the block's own timestamp — when the
   * thing actually happened. `"ingest"` is when this process saw it, used only
   * when the block could not be read (pruned node, reorg, RPC error).
   *
   * Absent on sources that do not read blocks. The distinction matters because
   * this is the audit trail: an event stamped with ingestion time and passed
   * off as block time is a falsified record, and nothing downstream could tell.
   */
  atSource?: "block" | "ingest";
  orgId?: string;
  payload: Record<string, unknown>;
}

