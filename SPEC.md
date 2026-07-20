# LaCrew Protocol Specification

**Version:** 0.1.0 (draft) · **License:** Apache-2.0 · **Solidity:** ^0.8.28

The treasury and governance layer for AI agent organizations: an onchain org
chart where every agent has a budget, overages climb an approval chain, and
constitutional changes pass through governance humans ultimately control.

This document is the normative protocol surface. Narrative documentation
lives in [`apps/docs/content/protocol/`](./apps/docs/content/protocol/);
reference implementations in [`contracts/src/`](./contracts/src/). Versions
follow semver: breaking interface changes bump the minor pre-1.0.

## 1. Design invariants

1. **Non-custodial.** No off-chain component ever holds root keys or an
   unmediated treasury path. Orchestrators act through scoped, expiring
   session keys; revocation runs from the root key.
2. **All enforcement onchain.** Budgets, permissions, escalation, and
   governance are contract-enforced. The cloud is replaceable.
3. **First DENY wins.** A node's policy is a stack of modules; DENY
   short-circuits, any ESCALATE routes the action up the reporting tree.
4. **Audit trail by construction.** Every intent, verdict, approval, vote,
   stream, and session event is emitted onchain; no separate logging system.
5. **Composability.** Third parties extend by writing policy modules and
   adapters — never by forking the protocol.

## 2. IPolicyModule — the extension point

```solidity
enum Verdict { ALLOW, ESCALATE, DENY }

interface IPolicyModule {
    /// Evaluate whether `agent` may call `target` with `value` and `data`.
    function check(address agent, address target, uint256 value, bytes calldata data)
        external view returns (Verdict);
}
```

A node's policy is a `PolicyStack` (itself an `IPolicyModule`) evaluating
members in order: the first DENY returns immediately; otherwise any ESCALATE
is sticky and returned; otherwise ALLOW. Standard modules shipped as
reference:

| Module | Behavior |
| --- | --- |
| `SpendCapPolicy` | Per-agent cap on `value`; over-cap → ESCALATE. Mutator `setAgentCap` is admin- or governor-gated. |
| `WhitelistPolicy` | Unlisted `target` → DENY. Mutator `setAllowed` is admin- or governor-gated. |
| `RateLimitPolicy` | Sliding-window action count per agent; over-rate → ESCALATE. The router records via `IRateRecorder.record(agent)`. |
| `TimeWindowPolicy` | Outside the configured UTC window → DENY. |

Stacks bind per node through `EscalationRouter.setNodePolicy(node, module)`
(governor-gated once a governor is set).

## 3. OrgRegistry — the tree

Nodes are accounts (`HumanRoot | ManagerAgent | WorkerAgent`); edges are
reporting lines. After a governor is set, structural mutators are
governor-only — structure changes are constitutional actions.

```solidity
function getNode(address account) external view returns (Node memory);
function getChildren(address parent) external view returns (address[] memory);
function addNode(address account, NodeKind kind, address parent) external;   // governor
function removeNode(address account) external;                               // children rewire to parent
function reparent(address account, address newParent) external;              // cycle-safe
function setActive(address account, bool active) external;
```

Events: `NodeAdded`, `NodeRemoved`, `NodeReparented`, `NodeActiveUpdated`.

## 4. Treasury & EpochStreamer — payroll semantics

The `Treasury` holds org funds; nothing pulls from it directly. Allowances
stream downward per node; agents spend their allowance (via the router),
never the treasury. `EpochStreamer` runs the schedule:

```solidity
function setGrant(address node, uint256 amount) external;   // operator or governor
function runNextEpoch() external returns (uint64 epoch);    // operator
function recipients() external view returns (address[] memory);
```

Events: `GrantUpdated`, `EpochRun(epoch, recipientCount)`. The treasury
implements `ITreasurySpender.spendAllowance(node, amount, to)` for the
router's finalize path.

### 4.1 Multi-asset orgs

A `Treasury` binds one immutable ERC-20. An org funds N assets by deploying
one **Treasury + EscalationRouter + EpochStreamer per asset** over a shared
`OrgRegistry`, so the org chart stays single while enforcement is
asset-scoped. Proven in `contracts/test/MultiAsset.t.sol`: allowances stream
and spend independently, a treasury never moves a foreign token, and pending
escalations resolve only in their own asset's router.

> **Policy stacks are asset-denominated.** `SpendCapPolicy` compares raw
> `uint256` values, so a 100 USDC cap (`100e6`) is dust against an 18-decimal
> asset. Deploy a separate stack per asset; never share one across assets
> with different decimals.

## 5. EscalationRouter — the enforcement path

Agents act by proposing intents. The router checks the agent's session key,
then its policy stack:

```solidity
function propose(address agent, address target, uint256 value, bytes calldata data)
    external returns (uint256 intentId, Verdict verdict);
function resolve(uint256 intentId, bool approved) external;
function setNodePolicy(address node, address policyModule) external;  // governor
```

- **ALLOW** → the action finalizes immediately: allowance spent, `target`
  called, `ActionExecuted` emitted.
- **ESCALATE** → a pending intent is created awaiting the agent's parent.
  `resolve(id, true)` from the awaiting approver re-checks the approver's own
  policy stack: within bounds it finalizes; over bounds the intent climbs
  (`IntentEscalated`) toward the human root. `resolve(id, false)` closes it.
- **DENY** → `propose` reverts; nothing is created.

Session gating: `propose` requires a valid `SessionRegistry` key for
`agent`, with `value <= maxValue` and, when pinned, `target == allowedTarget`.

Events: `IntentCreated`, `IntentEscalated`, `IntentResolved`,
`ActionExecuted(agent, target, value, callOk)`.

## 6. GovernanceModule — constitutional actions

Quorum voting over structure, budgets, and policy upgrades. Two tiers:

- **Low** (`Tier.Low`): instant execution once `yesVotes >= quorumYes`.
- **High** (`Tier.High`): treasury/policy-touching; additionally requires
  `yesHumanVotes >= quorumHumanYes`, a timelock (`eta`), and remains
  human-vetoable until execution.

Seats are role-weighted (`SeatRole.Human | Agent`); agent seats carry review
authority but human seats hold final say on high tier. Any funded Human seat
may veto.

```solidity
function propose(Tier tier, address target, bytes calldata data) external returns (uint256);
function vote(uint256 proposalId, bool support) external;
function veto(uint256 proposalId) external;      // high tier, human seats
function execute(uint256 proposalId) external;   // after quorum (+ timelock on high)
function setVotingPower(address voter, uint256 power, SeatRole role) external;  // root
```

Events: `ProposalCreated`, `Voted`, `ProposalExecuted`, `ProposalVetoed`,
`ProposalDefeated`.

## 7. SessionRegistry — bounded, expiring authority

Agents boot with ephemeral keys scoped to their policy; orchestrator
compromise leaks bounded, expiring authority — never the treasury.

```solidity
function issue(address agent, address key, uint64 expiresAt, bytes32 scopesHash,
               uint256 maxValue, address allowedTarget) external returns (uint256 sessionId); // issuer
function revoke(uint256 sessionId) external;                    // root or issuer
function isKeyValid(address agent, address key) external view returns (bool);
function keyLimits(address agent, address key) external view returns (uint256 maxValue, address allowedTarget);
```

Events: `SessionIssued`, `SessionRevoked`. Root revocation never depends on
the issuer — the root key can always kill a session.

## 8. Event taxonomy (audit trail)

Consumers index these families; the reference indexer streams them into
Postgres (`orchestrator_audit_events`), which dashboards and monitors read.

| Family | Events |
| --- | --- |
| Intents | `IntentCreated`, `IntentEscalated`, `IntentResolved`, `ActionExecuted` |
| Payroll | `GrantUpdated`, `EpochRun` (surfaced as `AllowanceStreamed`) |
| Governance | `ProposalCreated`, `Voted`, `ProposalExecuted`, `ProposalVetoed`, `ProposalDefeated` |
| Sessions | `SessionIssued`, `SessionRevoked` |
| Structure | `NodeAdded`, `NodeRemoved`, `NodeReparented`, `NodeActiveUpdated` |

## 9. Conformance

An implementation conforms to LaCrew v0.1 if:

1. every agent action passes an `IPolicyModule.check` stack with
   first-DENY-wins / any-ESCALATE-climbs semantics before funds move;
2. escalations resolve only through ancestors in the `OrgRegistry` tree,
   terminating at a human root;
3. treasury value reaches agents only as streamed allowances, spent through
   the router's finalize path;
4. constitutional actions execute only through the governance tiers above,
   with high-tier human final say and veto;
5. off-chain actors sign with registry-issued session keys bounded by
   `expiresAt`, `maxValue`, and `allowedTarget`.

Security process: see [`SECURITY.md`](./SECURITY.md). Threat notes:
[`apps/docs/content/protocol/security.md`](./apps/docs/content/protocol/security.md).
