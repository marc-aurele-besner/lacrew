# Security

LaCrew’s product promise is **bounded blast radius**: agents can spend only what policy allows, overages escalate, and constitutional changes go through governance with a human veto on high-tier actions.

## Status (honest)

This repository is **pre-audit** Phase 0/1 scaffolding. Treat all deployments as test-only until a professional audit is published (see PRD F1.2).

| Control                                                            | Code status                                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Policy stack (DENY / ESCALATE / ALLOW)                             | Implemented (+ fuzz: first-DENY-wins)                                                                 |
| Escalation climb + ALLOW spend execution                           | Implemented (EOA/router path; not ERC-4337 yet)                                                       |
| Treasury conservation                                              | Invariant suite (reserved ≤ balance; sum allowances)                                                  |
| Governance execute → OrgRegistry / Treasury / EpochStreamer grants | Implemented (role-weighted seats; human high-tier quorum)                                             |
| High-tier timelock + human veto                                    | Implemented (+ fuzz: unbypassable timelock / veto)                                                    |
| Multi-human seat admin                                             | Implemented (`admitHuman` / `removeHuman` governance-only; last human seat unremovable)               |
| Session keys                                                       | `SessionRegistry` ephemeral EOAs; `propose` gated by key + `maxValue` + optional target; not ERC-4337 |
| Professional audit / Slither gate                                  | Slither in CI (`fail-on: high`); no formal audit yet                                                  |

Docs that describe ERC-4337 / passkey AA roots are **design targets**, not current guarantees. Session scoping on `propose` is live on Anvil.

## Threat model (intended)

| Threat                   | Intended bound                                                                  |
| ------------------------ | ------------------------------------------------------------------------------- |
| Compromised agent        | Remaining streamed allowance on whitelisted targets; escalations climb the tree |
| Compromised orchestrator | Should only leak short-lived session keys — never treasury custody              |
| Compromised quorum       | High-tier timelock + veto from any funded human seat                            |
| Compromised root         | Bounded by the other human seats (below); still holds the wallet in v1          |

### Two humans: what a compromise of one actually costs

An org with human seats A (the root) and B is the shape agency partners and
clubs ask for. What a stolen A key buys, spelled out:

| A (root) alone can                                               | A alone cannot                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Retune quorums and timing; seat and re-weight **agent** seats    | Admit a human, re-weight one, or fire B — seat admin over humans executes only as a passed proposal |
| Vote its own weight; veto anything                               | Vote B's weight, or stop B vetoing back                                                             |
| Propose anything, including firing B                             | Land it: B vetoes, and B's veto needs no quorum and no delay                                        |
| Sign as session issuer and move the org wallet in v1 (see below) | Reach the treasury through governance without B's silence                                           |

So the multi-human guarantee this repo actually ships is **constitutional, not
custodial**: a compromised A cannot rewrite who governs the org, because B
remains seated and can veto. The last human seat cannot be removed at all, by
anyone, so an org can never be left with agents as its only electorate.

Two exposures are real and deliberately not papered over:

1. **The wallet is still single-holder.** The session-issuer path and the org's
   Safe key off one root address in v1. A compromised A can therefore still move
   funds the wallet controls, on the wallet's own terms — governance is not in
   that path. A club that needs two humans to jointly hold funds must configure
   a 2-of-2 Safe at the wallet layer today. Multi-holder root custody
   (`SPEC.md §6.1`) is a design target, not a current guarantee.
2. **A veto is a stop, not a recovery.** B can block every proposal A makes and
   cannot, alone, evict A: removing A's seat is itself a proposal, and A can
   veto it. Two compromised-but-opposed humans deadlock the constitution rather
   than one winning it. That is the intended failure mode — a frozen org is
   recoverable by agreement; a captured one is not — but it means "add a second
   human" is protection against a rogue partner, not a key-recovery mechanism.

Revoking the root's seat also revokes its parameter admin and its veto, so
governance can demote a root to an ordinary former member — but only while
another human remains seated, and only with that root unable to veto the
proposal, which in practice means with its cooperation.

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
