# LaCrew contracts

Foundry project for the onchain org chart, treasury, policies, escalation, and governance.

## Setup

```bash
forge install
forge build
forge test
```

`lib/` is gitignored; install forge-std (and later OpenZeppelin) locally via `forge install`.

## Layout

| Path | Role |
| --- | --- |
| `src/interfaces/` | Protocol standards (`IPolicyModule`, `IOrgRegistry`) |
| `src/policies/` | Policy modules (spend cap, …) |
| `src/*.sol` | OrgRegistry, Treasury, EscalationRouter, GovernanceModule |
| `script/` | Deploy scripts (Base Sepolia / Base) |
| `test/` | Foundry tests |

Implementations are scaffolding with `Mocked` / `TODO` markers — not production-ready.
