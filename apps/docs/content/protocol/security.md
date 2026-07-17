# Security model

Users do not buy composability. They buy **"my agents cannot rug me."**

## Threat → bound

| Threat | Blast radius |
| --- | --- |
| Compromised agent (prompt injection) | Remaining epoch allowance on whitelisted targets; escalations reviewed up-tree |
| Compromised orchestrator | Session keys only — scoped, expiring (hours). Policies onchain and immutable from the cloud |
| Compromised quorum | High-tier timelock + human veto |
| Compromised root | Out of protocol scope; use passkeys / hardware / multi-human roots |

## Non-custodial cloud

The hosted product provisions agents and proposes intents. It must be architecturally incapable of taking user funds. Revocation runs from the user's key, not ours.

## Defense in depth (planned)

- Transaction simulation before signing
- Velocity anomaly detection (`guardian` in the private cloud — monitoring, not enforcement)
- Event-sourced audit trail as a free byproduct of intents
