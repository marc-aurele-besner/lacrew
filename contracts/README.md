# LaCrew contracts

Foundry project for the onchain org chart, treasury, policies, escalation, and governance.

## Setup

```bash
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.3.0 --no-git
forge build
forge test
```

`lib/` is gitignored; install forge-std + OpenZeppelin locally via `forge install`.

## Layout

| Path | Role |
| --- | --- |
| `src/interfaces/` | Protocol standards (`IPolicyModule`, `IOrgRegistry`) |
| `src/policies/` | Policy modules (spend cap, …) |
| `src/mocks/` | MockUSDC for Anvil / testnets |
| `src/*.sol` | OrgRegistry, Treasury, EscalationRouter, GovernanceModule |
| `script/` | Deploy scripts (Anvil / Ethereum Sepolia / Base) |
| `test/` | Foundry tests |

Implementations are scaffolding with `Mocked` / `TODO` markers — not production-ready.
