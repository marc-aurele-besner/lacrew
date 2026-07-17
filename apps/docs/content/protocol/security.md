# Security model

Users do not buy composability. They buy **"my agents cannot rug me."**

> **Honesty check:** session keys, passkeys, and ERC-4337 are **not implemented yet**. Orchestrator compromise today is not bounded by onchain session modules — see root [`SECURITY.md`](https://github.com/marc-aurele-besner/lacrew/blob/main/SECURITY.md).

## Threat → intended bound

| Threat | Intended blast radius | Code today |
| --- | --- | --- |
| Compromised agent | Remaining streamed allowance on whitelisted targets; escalations climb | Policy + router + treasury spend path |
| Compromised orchestrator | Scoped expiring session keys only | **Mock UUID sessions** — AA/session modules TODO |
| Compromised quorum | High-tier timelock + human veto | Timelock + `veto` on `GovernanceModule` |
| Compromised root | Out of protocol scope | Multi-human roots first-class (design) |

## Non-custodial cloud

The hosted product provisions agents and proposes intents. It must be architecturally incapable of taking user funds. Revocation runs from the user's key, not ours.

## Defense in depth (planned)

- Transaction simulation before signing (router call is simulated in the SDK; agent action simulation TODO)
- Velocity anomaly detection (`guardian` in the private cloud — monitoring, not enforcement)
- Event-sourced audit trail as a free byproduct of intents
