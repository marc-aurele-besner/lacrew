---
title: "Escalation flow"
---

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
3. Human root approvals are passkey signatures; where the root is a Safe the credential owns, that signature is the Safe's own — it authorizes an `execTransaction` whose `msg.sender` on `resolve` is the Safe. Managers may auto-approve within their own policy bounds. See [Self-hosting → When the root is a Safe](../self-host.md).
4. Every `IntentCreated` / `IntentResolved` event is part of the audit trail.

## Current scaffolding

`EscalationRouter.resolve` re-checks policy as the approver:

1. Reject → closed
2. Approver `ALLOW` → finalized
3. Approver `ESCALATE` → `awaitingApprover` climbs to the parent (`IntentEscalated`)
4. Human root approval finalizes even when still over soft caps (mocked root authority)

## When the tree changes under a pending intent

Authority to resolve belongs to nodes that are in the tree and active at the moment `resolve` is called.

| Situation                                       | What `resolve` does                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Awaiting approver deactivated or removed        | The approver can neither approve nor reject (`InactiveApprover`)                                 |
| Intent awaiting an inactive or removed approver | The org root resolves in its place, approve or reject. Nobody else can (`NotAwaitingApprover`)   |
| Awaiting approver still active                  | Only that approver resolves; the root has no shortcut and waits for the intent to climb          |
| Proposing agent deactivated or removed          | Approval reverts (`InactiveAgent`) at every step of the climb; rejection still closes the intent |
| Approver or agent reactivated                   | Back to normal: the approver resolves, the agent's intent can be approved                        |

The root is the single stand-in because it is the one node that can be neither deactivated nor removed, and because a removed approver has no parent left to fall back on. A fired agent's pending spend never executes; reject it to clear it from the queue.

Per-agent caps live on `SpendCapPolicy.setAgentCap`. `propose` must be signed by a valid `SessionRegistry` key (or the agent address). Structured scope checks and AA execution are still TODO.
