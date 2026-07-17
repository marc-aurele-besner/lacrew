# Protocol overview

LaCrew encodes an organization as a tree of smart accounts with streaming allowances and stacked policy modules.

```
Human root(s)
 └── Treasury
      ├── Manager agent
      │      ├── Worker
      │      └── Worker
      └── Manager agent
             └── Worker
```

## Components

| Contract | Role |
| --- | --- |
| OrgRegistry | Tree of nodes and reporting edges |
| Treasury | Holds funds; streams allowances downward |
| IPolicyModule | `check → ALLOW \| ESCALATE \| DENY` |
| EscalationRouter | Pending intents climb the tree |
| GovernanceModule | Constitutional changes only |

Operational spend never votes. Constitutional changes (hire/fire, budgets, policy upgrades) go through governance with risk-tiered execution.

## TODO

- TODO: Formalize event schemas for the audit trail indexer (Ponder)
- TODO: Spec session-key lifecycle against ERC-4337 modules
