# Security

LaCrew’s product promise is **bounded blast radius**: agents can spend only what policy allows, overages escalate, and constitutional changes go through governance with a human veto on high-tier actions.

## Status (honest)

This repository is **pre-audit** Phase 0/1 scaffolding. Treat all deployments as test-only until a professional audit is published (see PRD F1.2).

| Control | Code status |
| --- | --- |
| Policy stack (DENY / ESCALATE / ALLOW) | Implemented |
| Escalation climb + ALLOW spend execution | Implemented (EOA/router path; not ERC-4337 yet) |
| Governance execute → OrgRegistry / Treasury | Implemented (1-vote-per-address; hardcoded quorum) |
| High-tier timelock + human veto | Implemented (scaffolding constants) |
| Session keys / passkeys / ERC-4337 | **Not implemented** — orchestrator uses mock UUIDs |
| Professional audit / Slither gate | Slither in CI when available; no formal audit yet |

Docs that describe session-key scoping or AA roots are **design targets**, not current guarantees.

## Threat model (intended)

| Threat | Intended bound |
| --- | --- |
| Compromised agent | Remaining streamed allowance on whitelisted targets; escalations climb the tree |
| Compromised orchestrator | Should only leak short-lived session keys (not built yet) — never treasury custody |
| Compromised quorum | High-tier timelock + human-root veto |
| Compromised root | Out of protocol scope; use hardware / multi-human roots |

## Reporting a vulnerability

Please email **security@lacrew.xyz** (or open a private GitHub security advisory on this repo) with:

1. Affected contracts/packages and commit SHA
2. Impact description (funds at risk, privilege escalation, DoS)
3. Proof of concept (local Anvil preferred)

We aim to acknowledge within **72 hours**. Do not open a public issue for fund-draining bugs until we confirm a fix or disclosure timeline.

## Safe testing

- Prefer Anvil / Base Sepolia with throwaway keys
- Never send mainnet funds to undeployed or unaudited addresses
- Published addresses will live in `packages/core/deployments/` and on `lacrew.xyz/protocol` once live
