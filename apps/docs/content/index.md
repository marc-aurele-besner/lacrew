# LaCrew docs

> Your agents. Their budgets. Your keys.

Protocol spec, contract interfaces, SDK reference, and self-hosting guide for
LaCrew — the onchain org chart, budget, and escalation layer for AI agent teams.

## Start here

- [Protocol specification](./spec.md) — the normative interface surface, invariants, and conformance rules (v0.1 draft)
- [Protocol overview](./protocol/overview.md) — the narrative introduction

## Protocol

- [IPolicyModule](./protocol/policy-module.md)
- [Escalation flow](./protocol/escalation.md)
- [Governance](./protocol/governance.md)
- [Security model](./protocol/security.md)

## Build

- [SDK reference](./sdk.md) — hand-written guide
- [API reference](./reference/README.md) — generated from source by TypeDoc
- [Flows](./flows.md)
- [Connectors](./connectors.md) — how a crew reaches GitHub, a CMS, or an RPC, on an allowlist the operator writes
- [Crew blueprints](./crews.md) — a vertical as data: org chart, budgets, guardrails, and the plan that stands it up
- [Crew heartbeat](./heartbeat.md) — a standing checklist a crew works through on its own cadence, reported in the thread
- [Skill packs](./skill-packs.md) — directive skills as a versioned artifact: install one onto a seat, update it, take it back off
- [Self-hosting](./self-host.md)

## TODO

- TODO: Adopt Fumadocs (or Docusaurus) in place of the static HTML builder
