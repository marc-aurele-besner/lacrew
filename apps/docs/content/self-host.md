# Self-hosting (draft)

Self-host loses nothing except convenience. The cloud is a thin commercial shell around the OSS core.

## Quick local loop (Mocked)

```bash
pnpm install
pnpm build

# Contracts
cd contracts && forge install foundry-rs/forge-std --no-git
forge test

# CLI against mock SDK
pnpm --filter @lacrew/cli exec tsx src/index.ts org
pnpm --filter @lacrew/cli exec tsx src/index.ts tick

# Orchestrator HTTP
pnpm --filter @lacrew/orchestrator dev
# GET /health  POST /boot  POST /tick  GET /intents
```

## TODO

- TODO: `lacrew init` to scaffold an org + env files
- TODO: Docker Compose for orchestrator + Postgres + Redis
- TODO: Document Base Sepolia deploy via `DeployMockOrg.s.sol`
- TODO: Publish `@lacrew/sdk` / `@lacrew/orchestrator` to npm
