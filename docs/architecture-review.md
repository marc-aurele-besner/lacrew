# Non-custodial architecture review checklist (PRD F2.2 / §6)

Use this checklist for every feature that touches keys, funds, sessions, or governance. A feature fails review if any box cannot be answered honestly.

## Invariants

1. **Root keys stay with the user** — passkey smart account or user-held MPC share. Cloud never persists root private material.
2. **Cloud proposes; chain enforces** — every spend / hire / fire / grant / policy change is checked onchain against policies the cloud cannot silently rewrite.
3. **Session keys are scoped + expiring** — agents hold short-lived keys; compromise blast radius ≤ remaining allowance on whitelisted targets.
4. **Revocation is user-driven** — root or issuer can revoke sessions; monitoring (Guardian) may *recommend* revoke but must not be the only control.
5. **No unmediated treasury path** — API / orchestrator / indexer cannot move org funds except through EscalationRouter + policies.

## Per-feature questions

| # | Question | Pass criteria |
| --- | --- | --- |
| 1 | Does this feature store or transmit a root private key / seed / passkey private material? | Must be **no**. |
| 2 | Can the cloud change policy, grants, or org structure without an onchain proposal? | Must be **no** (or clearly off-path demo mock labeled as such). |
| 3 | If a session key is stolen, what is the max loss before expiry/revoke? | Bounded by epoch grant + whitelist; documented. |
| 4 | Does Guardian / monitoring ever execute spends? | Must be **no** — alert + optional recommend-revoke only. |
| 5 | Are new mutators gated by GovernanceModule (or an existing onchain admin that is the governor)? | Yes for constitutional changes. |
| 6 | Is mock/offline behavior clearly labeled in UI and API (`mocked`, `source`)? | Yes — never look like custody. |
| 7 | Would self-hosting without lacrew.xyz lose enforcement? | Must be **no** — enforcement is in public contracts/SDK/orch. |

## Current status (honest)

| Layer | Status |
| --- | --- |
| SessionRegistry + ephemeral propose keys | Live on Anvil; not AA (F1.3) |
| Passkey ceremony | Browser WebAuthn attempt; attestation not verified; no AA root |
| Policy mutators | Governor-gated onchain |
| Cloud control plane | Proxies orch; holds tenant metadata + short-lived session material only |
| Guardian | Monitoring UI + ack persistence; auto-revoke unwired |

## Sign-off

Feature: _______________  
Reviewer: _______________  
Date: _______________  
Result: Pass / Fail — notes: _______________
