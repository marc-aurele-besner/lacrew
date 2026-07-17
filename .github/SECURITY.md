# Security

LaCrew's product promise is bounded autonomy: a compromised agent or orchestrator must not drain the treasury.

## Reporting

Please report vulnerabilities privately. Prefer GitHub Security Advisories on this repository once enabled.

Do **not** open a public issue for active fund-risk bugs.

## Scope (intended)

- Smart contracts under `contracts/src`
- Session key issuance and revocation paths in `@lacrew/orchestrator`
- Policy evaluation correctness (`IPolicyModule` stacks)

## Out of scope (for now)

- Mocked / Phase 0 scaffolding clearly marked `Mocked` or `TODO`
- Third-party wallet providers behind adapters
- Social engineering of root key holders

## Notes

Root key compromise is out of protocol scope by design. Prefer passkeys / hardware / multi-human roots.
