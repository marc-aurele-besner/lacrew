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
  | "MarketplacePurchase"
  | "MarketplaceListed"
  | "MarketplaceWithdrawn";

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

