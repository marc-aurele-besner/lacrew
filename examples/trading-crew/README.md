# Example: trading crew

Mocked starter template for a scanner → executor → risk-manager crew sharing a treasury with hard per-agent caps.

## Shape (planned)

```
Human root
 └── Treasury
      ├── Risk manager  [approves escalations]
      ├── Scanner       [read-only / tiny allowance]
      └── Executor      [position-taking within cap]
```

## Status

Scaffold only. Uses `@lacrew/core` mock org data conceptually.

## TODO

- TODO: Wire example to `@lacrew/cli` and `@lacrew/orchestrator`
- TODO: Document latency boundary (no MEV / HFT through onchain approval)
- TODO: Add sample policy module config JSON
