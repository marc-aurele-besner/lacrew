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
  /**
   * A webhook flow trigger was created, rotated, enabled, disabled, or removed
   * (F2.22). A hook URL is standing authority to start a funded flow from
   * outside the org, so who minted one — and who rotated its secret — belongs
   * in the trail. The payload never carries the secret, sealed or otherwise;
   * only its version, which is what a delivery line can be matched against.
   */
  | "WebhookTriggerChanged"
  /**
   * One signed delivery was accepted and enqueued (F2.22).
   *
   * Records the delivery key, the run it started, and the principal it will run
   * as — never the request body, which is attacker-supplied, unbounded, and
   * routinely full of someone else's personal data. Rejected deliveries are not
   * here: they changed nothing, and an unauthenticated caller must not be able
   * to write to the audit ring. They land in the trigger's delivery log with a
   * reason code instead.
   */
  | "WebhookDelivery"
  /**
   * A connector write route's mode was set or cleared (F2.24).
   *
   * `auto` / `ask` / `deny` is an operator control in the same family as a
   * pause or a directive edit: it never widens what a crew may reach, but
   * moving a merge route from `ask` to `auto` removes the human from the loop
   * on every future merge, and that decision should be attributable to whoever
   * made it rather than inferred from the absence of questions.
   */
  | "ConnectorWritePolicyChanged"
  /**
   * A write in `ask` mode stopped to ask a human (F2.24).
   *
   * Carries the fingerprint of the request that a "yes" would release, never
   * the arguments: a rendered path routinely names a private repository or a
   * customer, and the trail is not the place to publish one. Nothing was
   * called when this row was written — that is the whole content of the event.
   */
  | "ConnectorAsk"
  /**
   * An ask ended: `approved`, `declined`, or `expired` (F2.24).
   *
   * A confirmation is a claim, not an authority — it releases a step policy
   * had already admitted and admits nothing on its own. `expired` is here for
   * the same reason the other two are: a write that never happened because
   * nobody answered is an outcome an operator needs to be able to find.
   */
  | "ConnectorAskResolved"
  /**
   * Someone replied to an ask without answering it (F2.24). The question was
   * re-posted and the write is still waiting; recorded because a reply that
   * looks like a decision and is not is exactly what a later reader would
   * otherwise mistake for one.
   */
  | "ConnectorAskUnresolved"
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
  | "AgentResumed"
  /**
   * An agent's standing directive was rewritten (F1.7).
   *
   * Arguably the change most worth attributing of the three: a pause is
   * visible the moment an agent stops working, whereas a directive edit leaves
   * it working and changes what it does. Someone quietly adding a repo to a
   * crew's care, or a skill telling it to merge on green, would otherwise
   * appear nowhere.
   *
   * The payload records the directive's *shape* — which layers, how many
   * resources and skills, whether it was cleared — and never the instruction
   * text. The trail is a memory-bounded ring and a directive runs to thousands
   * of characters; the text itself is served, in full, by /agents/controls.
   */
  | "AgentDirectiveChanged"
  /**
   * A skill pack was installed onto, or removed from, an agent's directive
   * (F2.23).
   *
   * `AgentDirectiveChanged` already records that the directive moved; these say
   * *what* moved it — which pack, at which version, and how many skills it
   * contributed. That distinction is the one an operator needs when a crew's
   * behaviour changes after an install: a pack is somebody else's instructions
   * entering their agents, and the version is what makes "it started doing this
   * last Tuesday" checkable.
   *
   * The payload carries counts and ids, never a skill body. A pack body runs to
   * thousands of characters, the trail is a bounded ring, and the text is
   * served in full by the directive itself.
   */
  | "SkillPackInstalled"
  | "SkillPackRemoved"
  /**
   * Someone posted to the crew's conversation (F1.7).
   *
   * Records that a claim was made and by whom — never that the claim is true.
   * A message asserting a spend is not a spend; the spend has its own rows, and
   * conflating them would put an agent's assertion in the record of settled
   * facts. The body is deliberately absent: the trail is a bounded ring, and
   * the message is served in full from the conversation endpoints.
   */
  | "MessagePosted";

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

