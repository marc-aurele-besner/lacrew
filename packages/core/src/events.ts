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
   * One key retired and a replacement issued under the retired key's own
   * bounds (F0.7). Kept distinct from the `SessionRevoked` + `SessionIssued`
   * pair it sits beside: those two rows say a key died and a key was born,
   * and only this one says the second inherited the first's authority rather
   * than being handed fresh authority of its own.
   */
  | "SessionRotated"
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
   * A run's lifecycle was changed by a person rather than by the flow (F2.26):
   * paused mid-flight, resumed from a checkpoint, or cancelled for good.
   *
   * Separate from `FlowRun` because the question they answer is different — not
   * "what did the crew do" but "who stopped it, and when". A cancelled run that
   * had already spent leaves both rows, and the pair is the record.
   */
  | "FlowRunLifecycle"
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
  /**
   * A side effect was refused because the agent had not said what it was about
   * to do (F2.31).
   *
   * The row an operator reads to find work a crew *wanted* to do and did not —
   * which is the only trace such an attempt leaves, since nothing was built, no
   * policy was consulted and nothing left the process. It carries the tool, the
   * principal, the mode that refused it and whether a plan was missing or
   * merely stale; never the thread's contents, because a plan body names
   * counterparties, repositories and amounts.
   *
   * Not a policy verdict and not a denial of authority: the crew was admitted
   * to take this action and remains so. What it lacked was a statement on the
   * record, and posting one lets it proceed — into the same policy stack as
   * before.
   */
  | "PlanRequiredBlocked"
  /**
   * An operator changed a scope's plan-required mode (F2.31).
   *
   * Turning the mode *down* is the interesting direction: it is the moment a
   * crew stops having to say what it is about to do, and it should be as
   * attributable afterwards as raising a spend cap is.
   */
  | "PlanRequiredChanged"
  /**
   * A blueprint seat was bound to an account, or that binding was forgotten
   * (F2.25).
   *
   * Bookkeeping rather than enforcement — the row says which account the
   * `reviewer` seat landed on, and admits nothing. It is in the trail because
   * re-pointing a role id silently changes which principal a flow runs as, and
   * "who moved the reviewer" is a question asked afterwards.
   */
  | "CrewBindingChanged"
  /**
   * A blocking human gate opened: a `human` step posted its question and parked
   * the run (F2.27).
   *
   * The trail carries the option ids, never the rendered prompt — a question
   * can name a private repo or a counterparty, and this ring is not the place
   * to publish one. What a reader needs is which choices were on offer, which
   * run they are holding, and when the deadline falls.
   */
  | "HumanGateOpened"
  /**
   * A gate ended with a decision: `answered` (with the option and the human
   * seat that picked it) or `cancelled` when the run it belonged to ended.
   *
   * A gate is control, not authority: the answer released a pipeline the
   * principal was already allowed to run, and it approves no spend and changes
   * no policy. Who released it is still the question asked afterwards.
   */
  | "HumanGateResolved"
  /**
   * Nobody answered before the deadline (F2.27). The run takes its declared
   * timeout port, or stops — a gate that expired has decided nothing, and the
   * trail says so rather than leaving a silent gap where a decision should be.
   */
  | "HumanGateTimedOut"
  /**
   * Someone replied to a gate without resolving it (F2.27): free text that
   * matched no option, or an *agent* trying to answer a question meant for a
   * human. The run is still parked. Recorded because a crew that keeps
   * answering its own gate is something an operator should be able to see.
   */
  | "HumanGateUnresolved"
  /**
   * An effect stopped for a second pair of eyes (F2.32): the review question
   * was posted and the run parked.
   *
   * The row carries the tool, the acting seat, who was asked and — for a spend
   * — the amount, plus a fingerprint of the call itself, so a reader can tell
   * two reviews of the same tool apart. Never the arguments: a call's fields
   * name repositories and counterparties, and this ring is not the place to
   * publish one.
   *
   * `escalated` is the field worth reading twice. It says the configured
   * reviewer was unavailable — paused, fired, or the actor itself through a
   * misconfiguration — and a person was asked instead. A crew whose reviews are
   * all escalated has a reviewer setting that is not doing what it says.
   */
  | "DualControlOpened"
  /**
   * A second seat agreed, and the effect proceeded (F2.32).
   *
   * Concurring is control, not authority: it released a step the actor was
   * already permitted to take, and the spend behind it still met the policy
   * stack, still escalated and still needed its approval. Who agreed is the
   * question asked afterwards, which is why the seat and whether it was a
   * person are both on the row.
   */
  | "DualControlConcurred"
  /**
   * A second seat refused, and the effect was not attempted (F2.32).
   *
   * The row an operator reads to find work a crew wanted to do and a reviewer
   * stopped — the only trace it leaves, since nothing was built and nothing
   * left the process. Also written when a run is cancelled while an effect was
   * awaiting review, with `outcome: "cancelled"`.
   */
  | "DualControlRejected"
  /**
   * Nobody concurred before the deadline (F2.32). The effect fails closed.
   *
   * The opposite direction from a human gate's timeout, which takes a declared
   * port: a review that expired has decided nothing, and for a control whose
   * whole purpose is a second pair of eyes, "nobody looked" must never read as
   * "somebody agreed".
   */
  | "DualControlTimedOut"
  /**
   * Someone replied to a review without resolving it (F2.32): free text that
   * matched no option, a seat nobody asked — or the **actor answering its own
   * review**, which is the attack this control exists to stop. The run is still
   * parked. Recorded because a crew that keeps trying to concur with itself is
   * exactly what an operator should be able to find.
   */
  | "DualControlUnresolved"
  /**
   * An operator changed a scope's dual-control rule (F2.32).
   *
   * Turning it *down* is the interesting direction — it is the moment a crew
   * stops needing anyone else's agreement to merge or to spend — and so is
   * changing the reviewer, which can quietly move a review from a person to an
   * agent on the same orchestrator.
   */
  | "DualControlChanged"
  /**
   * Somebody ran the eval suite against this deployment (F2.29).
   *
   * An eval changes nothing — no spend, no call, no state — so this row is not
   * evidence about the crew. It is evidence about the *question being asked*:
   * a desk whose scenarios were last run in March, or a run that went from
   * green to two failures after a template edit, is exactly what a reader wants
   * to find when a crew starts behaving differently. Counts and timing only;
   * what each scenario asserts is served by the run itself.
   */
  | "FlowEvalRun"
  /**
   * A crew reached outside LaCrew through an **external** MCP server (F2.30).
   *
   * Distinct from `ToolCalled`, which is an operator-written connector route:
   * this one names third-party code the workspace attached, so "which server,
   * which tool, and did it actually go out" is the question the row answers. A
   * refusal is recorded too (`called: false` with the reason) — a tool that was
   * never allowlisted, a write refused by its mode, an ask with nowhere to go —
   * because an attempt on a tool nobody admitted is exactly what an operator
   * wants to see, and it leaves no other trace.
   *
   * Carries no arguments and no results by default. Tool arguments routinely
   * name a customer or a private repository, and a result is unbounded
   * third-party text; `LACREW_MCP_AUDIT_ARGS=1` adds argument *keys* only.
   */
  | "ExternalMcpCalled"
  /**
   * An external MCP server's tool list was re-read (F2.30), with what changed.
   *
   * The row exists for the tools that appeared: a server growing a tool between
   * refreshes is either a release or a supply-chain compromise, and from here
   * the two look identical — so the new names are recorded, they are blocked
   * until a person allows them, and the record is what makes "when did that
   * appear" answerable afterwards. A failed refresh is recorded too, because a
   * stale allowlist read as a confirmed one is its own hazard.
   */
  | "ExternalMcpDiscovered"
  /**
   * An operator allowed, disabled, or re-moded an external MCP tool (F2.30).
   *
   * The moment authority actually changes in this feature. Everything else is
   * default-deny; this is a person naming a third party's tool and admitting it
   * for a workspace, a crew, or a seat — which is precisely what should be
   * attributable later.
   */
  | "ExternalMcpToolPolicyChanged"
  /**
   * An external MCP server was attached, replaced, or detached at runtime, or
   * refused when a stored one was restored (F2.30).
   *
   * Attaching a server is naming a third party the orchestrator will talk to,
   * which is a bigger decision than admitting one of its tools and the one that
   * has to be answerable first: the row carries the endpoint, the transport,
   * the scope that attached it, and the env var *names* the config reads —
   * never a value.
   */
  | "ExternalMcpServerChanged"
  /**
   * A sealed credential an attached MCP server reads was stored or cleared
   * (F2.30).
   *
   * Kept apart from the server row because it answers a different question: not
   * "who did this workspace decide to talk to" but "which credential is it
   * talking with, and since when". The row carries the ref and the value's last
   * four characters — enough to tell one token from another during an incident,
   * and never enough to use one.
   */
  | "ExternalMcpSecretChanged"
  /**
   * A crew's inference cost budget was created, edited, enabled, disabled or
   * removed (F2.28).
   *
   * Raising a cap is the override this feature gives an operator, and it is the
   * one action that lets a stopped crew start spending again — so it belongs in
   * the trail beside the breach it answers. The payload carries the limits and
   * the policy, which are numbers an operator typed, never a prompt or a key.
   */
  | "InferenceBudgetChanged"
  /**
   * A crew passed the warn line on a cost budget (F2.28). Fired once per
   * crossing per period: the point is that a human sees it while there is still
   * room to act, and an alert per call above the line is an alert nobody reads.
   */
  | "InferenceBudgetWarned"
  /**
   * A crew reached a cost budget's limit (F2.28). Under a `hard` policy this is
   * also the moment model calls start being refused with
   * `inference_budget_exceeded`.
   *
   * Emphatically **not** an onchain event and not a spend: no funds moved, no
   * allowance changed, and the policy stack is untouched. It records that an
   * operational cost ceiling was reached, which is a different question from
   * anything the chain enforces.
   */
  | "InferenceBudgetExceeded"
  /**
   * A crew's standing checklist was created, edited, enabled, disabled or
   * removed (F2.21).
   *
   * A heartbeat is standing authority to start funded work on a timer, so who
   * put a flow on the list — and who turned the list on — belongs in the trail.
   * The payload carries the cadence, the principal and the item count, never
   * the checklist bodies: what each item is remains readable from the config
   * itself, and the trail is a bounded ring.
   */
  | "CrewHeartbeatChanged"
  /**
   * One heartbeat tick finished (F2.21).
   *
   * Distinct from the `FlowRun` rows its items produced, and deliberately so:
   * those say a flow ran, this says the crew's standing list was worked
   * through, by whom, and how much of it needed a human. It is also the row
   * that makes an *absent* heartbeat visible — a crew whose last tick is three
   * days old is not a quiet crew, it is a stopped one.
   */
  | "CrewHeartbeat"
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
