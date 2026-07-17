# Example: dev crew

Mocked starter for agents whose work is off-chain (code, reviews) but whose spending is real: compute, APIs, contractor payouts.

## Shape (planned)

```
Human root
 └── Treasury
      ├── Manager agent
      │      ├── Coder worker
      │      └── Reviewer worker
      └── Ops worker [API / compute spend]
```

## Status

Scaffold only.

## TODO

- TODO: Example x402-style payment flow against a mocked allowance
- TODO: MCP tool list for coding agents via `@lacrew/adapter-agents-mcp`
