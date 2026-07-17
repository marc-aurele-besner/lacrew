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

The mocked `EscalationRouter` stores intents and lets the immediate parent resolve. Recursion and on-execution ALLOW paths are still TODO.
