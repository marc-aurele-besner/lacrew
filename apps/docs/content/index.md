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
- [External MCP servers](./external-mcp.md) — attach somebody else's MCP server, one allowed tool at a time; new tools arrive blocked
- [Crew blueprints](./crews.md) — a vertical as data: org chart, budgets, guardrails, and the plan that stands it up
- [Crew heartbeat](./heartbeat.md) — a standing checklist a crew works through on its own cadence, reported in the thread
- [Flow & blueprint evals](./evals.md) — the deterministic scenario suite that holds a crew to what its blueprint claims it cannot do
- [Inference cost budgets](./inference-budgets.md) — what a crew's model calls may cost you, bounded separately from what it may spend onchain
- [Crew P&L](./pnl.md) — one period report over onchain spend, model cost and connector usage; price unknown is never $0
- [Plan-required mode](./plan-required.md) — no plan, no side effect: make a crew say what it is about to do before it does it
- [Dual control](./dual-control.md) — a second seat concurs, or the effect does not happen: four-eyes review in front of a merge or a spend
- [Skill packs](./skill-packs.md) — directive skills as a versioned artifact: install one onto a seat, update it, take it back off
- [Self-hosting](./self-host.md)

## TODO

- TODO: Adopt Fumadocs (or Docusaurus) in place of the static HTML builder
