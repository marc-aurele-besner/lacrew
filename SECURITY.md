# Security

LaCrew’s product promise is **bounded blast radius**: agents can spend only what policy allows, overages escalate, and constitutional changes go through governance with a human veto on high-tier actions.

## Status (honest)

This repository is **pre-audit** Phase 0/1 scaffolding. Treat all deployments as test-only until a professional audit is published (see PRD F1.2).

| Control | Code status |
| --- | --- |
| Policy stack (DENY / ESCALATE / ALLOW) | Implemented (+ fuzz: first-DENY-wins) |
| Escalation climb + ALLOW spend execution | Implemented (EOA/router path; not ERC-4337 yet) |
| Treasury conservation | Invariant suite (reserved ≤ balance; sum allowances) |
| Governance execute → OrgRegistry / Treasury / EpochStreamer grants | Implemented (role-weighted seats; human high-tier quorum) |
| High-tier timelock + human veto | Implemented (+ fuzz: unbypassable timelock / veto) |
| Session keys | `SessionRegistry` ephemeral EOAs; `propose` gated by key + `maxValue` + optional target; not ERC-4337 |
| Professional audit / Slither gate | Slither in CI (`fail-on: high`); no formal audit yet |

Docs that describe ERC-4337 / passkey AA roots are **design targets**, not current guarantees. Session scoping on `propose` is live on Anvil.

## Threat model (intended)

| Threat | Intended bound |
| --- | --- |
| Compromised agent | Remaining streamed allowance on whitelisted targets; escalations climb the tree |
| Compromised orchestrator | Should only leak short-lived session keys — never treasury custody |
| Compromised quorum | High-tier timelock + human-root veto |
| Compromised root | Out of protocol scope; use hardware / multi-human roots |

## Reporting a vulnerability

Please email **security@lacrew.xyz** (or open a private GitHub security advisory on this repo) with:

1. Affected contracts/packages and commit SHA
2. Impact description (funds at risk, privilege escalation, DoS)
3. Proof of concept (local Anvil preferred)

We aim to acknowledge within **72 hours**. Do not open a public issue for fund-draining bugs until we confirm a fix or disclosure timeline.

## Safe testing

- Prefer Anvil / Ethereum Sepolia with throwaway keys
- Never send mainnet funds to undeployed or unaudited addresses
- Published addresses will live in `packages/core/deployments/` and on `lacrew.xyz/protocol` once live
