# Self-hosting

Self-host loses nothing except convenience. The cloud is a thin commercial shell around the OSS core.

## Anvil reference loop

```bash
pnpm install

# Contracts deps (lib/ is gitignored)
cd contracts
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.3.0 --no-git
forge test
cd ..

# Terminal A — local chain
anvil

# Terminal B — scaffold + deploy
pnpm --filter @lacrew/cli exec tsx src/index.ts init
pnpm --filter @lacrew/cli exec tsx src/index.ts deploy --anvil

# Sync writes packages/core/deployments/31337.json (and anvil.json)
# Read the onchain org tree
pnpm --filter @lacrew/cli exec tsx src/index.ts org --rpc http://127.0.0.1:8545

# Payroll epoch (streams configured grants via EpochStreamer; needs PRIVATE_KEY = human root)
pnpm --filter @lacrew/cli exec tsx src/index.ts epoch --rpc http://127.0.0.1:8545

# Optional: lightweight event indexer for audit / pending intents
pnpm --filter @lacrew/indexer dev
# INDEXER_PATH=.lacrew/indexer.json lacrew audit --rpc
```

## Mock-only quick start (no chain)

```bash
pnpm install
pnpm build

pnpm --filter @lacrew/cli exec tsx src/index.ts org
pnpm --filter @lacrew/cli exec tsx src/index.ts tick

# Orchestrator HTTP (:8788)
pnpm --filter @lacrew/orchestrator dev
# GET /health  POST /boot  POST /tick  GET /intents  GET /org
```

## Postgres (Neon or Docker)

Orchestrator state and pg-boss jobs use one Postgres via `DATABASE_URL` (Neon hosted, or local Docker). Redis is not required.

```bash
# Local
docker compose up -d
export DATABASE_URL=postgres://lacrew:lacrew@localhost:5432/lacrew

# Or paste a Neon connection string (same env var)
# export DATABASE_URL=postgresql://user:pass@ep-….neon.tech/neondb?sslmode=require

pnpm --filter @lacrew/db db:migrate
pnpm --filter @lacrew/orchestrator dev
# GET /health → db.ready + queue.provider "pg-boss" when DATABASE_URL is set
```

Optional indexer DB on the same Postgres instance:

```bash
docker compose exec postgres psql -U lacrew -c 'CREATE DATABASE lacrew_indexer;'
```

## Ethereum Sepolia (optional)

Set env and deploy with the same script (does not block local demos):

```bash
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
export PRIVATE_KEY=0x…   # funded test key
export HUMAN_ROOT=0x…    # optional; defaults to deployer
export CHAIN_ID=11155111

cd contracts
forge script script/DeployMockOrg.s.sol:DeployMockOrg \
  --rpc-url $SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast

cd ..
pnpm --filter @lacrew/core sync-abis
```

Or: `pnpm --filter @lacrew/cli exec tsx src/index.ts deploy` with `SEPOLIA_RPC_URL` + `PRIVATE_KEY` set.

Override addresses via `LACREW_ORG_REGISTRY`, `LACREW_TREASURY`, `LACREW_ESCALATION_ROUTER`, etc.

## Cloud pairing (lacrew.xyz)

Run the public orchestrator on `:8788`, then the private API on `:8789` and web on `:3000`. See the lacrew.xyz README for `file:` package wiring.

## TODO

- TODO: Publish `@lacrew/sdk` / `@lacrew/orchestrator` / `@lacrew/db` to npm
- TODO: Full Ponder + Postgres indexer (Phase 1)
- TODO: Production session-key setup, upgrade path, and troubleshooting
