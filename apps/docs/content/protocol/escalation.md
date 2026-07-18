# Escalation flow

Operational spend never votes. When a policy returns `ESCALATE`, the EscalationRouter opens a pending intent and walks the reporting line until a node with sufficient authority resolves it.

```
Worker proposes action
        │
        ▼
 PolicyStack.check ── DENY ──► revert
        │
     ALLOW ──► execute (session key / smart account)
        │
    ESCALATE
        │
        ▼
 Intent created · awaiting = parent
        │
   Parent resolve(approved?)
        │
        ├── false → closed
        └── true  → (TODO) re-check parent policy / recurse / execute
```

## Rules

1. Leaves never pull from the treasury; they spend allowance only.
2. Escalation is a purchase order, not a governance vote.
3. Human root approvals are passkey signatures (planned); managers may auto-approve within their own policy bounds.
4. Every `IntentCreated` / `IntentResolved` event is part of the audit trail.

## Current scaffolding

`EscalationRouter.resolve` re-checks policy as the approver:

1. Reject → closed
2. Approver `ALLOW` → finalized
3. Approver `ESCALATE` → `awaitingApprover` climbs to the parent (`IntentEscalated`)
4. Human root approval finalizes even when still over soft caps (mocked root authority)

Per-agent caps live on `SpendCapPolicy.setAgentCap`. `propose` must be signed by a valid `SessionRegistry` key (or the agent address). Structured scope checks and AA execution are still TODO.
