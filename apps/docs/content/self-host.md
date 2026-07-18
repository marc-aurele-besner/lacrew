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

### Divergent local chains (long-lived Anvil)

Redeploying onto a used Anvil produces nonce-shifted addresses that no longer
match the committed `31337.json`. Instead of committing local artifacts, pin
the deployment in `.env` — `getAddresses()` lets every field be overridden via
`LACREW_*` env vars:

```bash
pnpm --filter @lacrew/core addresses:env >> .env   # emits LACREW_* lines from contracts/deployments/31337.json
git checkout -- contracts/deployments packages/core/deployments packages/core/src/deployments.generated.ts
```

Remove the override block from `.env` when you return to a fresh-Anvil deploy.

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

## Session keys

Onchain mode (`ANVIL_RPC` + `PRIVATE_KEY`) issues ephemeral EOAs via `SessionRegistry`:

```bash
# Boot provisions a worker session (gas stipend + maxValue scope)
curl -s -X POST http://127.0.0.1:8788/boot | jq .

# List / revoke
curl -s http://127.0.0.1:8788/sessions | jq .
curl -s -X POST http://127.0.0.1:8788/sessions/revoke \
  -H 'content-type: application/json' \
  -d '{"sessionId":"…"}' | jq .
```

Compromise blast radius is the session's remaining `maxValue` on whitelisted targets until expiry or root/issuer revoke. Root keys never leave the operator's wallet.

## Model provider

Orchestrator model calls go through `ModelProvider` (never a hard-wired vendor SDK):

```bash
# Memory stub (default)
curl -s -X POST http://127.0.0.1:8788/model/complete \
  -H 'content-type: application/json' \
  -d '{"prompt":"Summarize pending escalations"}' | jq .

# OpenRouter when OPENROUTER_API_KEY is set — see .env.example
curl -s http://127.0.0.1:8788/health | jq .model
```

## MCP tools

```bash
# JSON-RPC stdio server (Cursor / Claude Desktop compatible shape)
pnpm --filter @lacrew/adapter-agents-mcp mcp

# HTTP surface on the orchestrator (also proxied by lacrew.xyz API)
curl -s http://127.0.0.1:8788/mcp/tools | jq .
curl -s -X POST http://127.0.0.1:8788/mcp/call \
  -H 'content-type: application/json' \
  -d '{"name":"lacrew_get_org_tree","arguments":{}}' | jq .

# Vercel AI–shaped tool map (no `ai` SDK dep yet)
# import { createLacrewVercelAiTools } from "@lacrew/adapter-agents-vercel-ai"
```

## HTTP auth

The orchestrator HTTP surface is open by default (fine for localhost demos). Set
`LACREW_ORCH_TOKEN` to require `Authorization: Bearer <token>` on every route
except `GET /health` (kept open for probes):

```bash
LACREW_ORCH_TOKEN=$(openssl rand -hex 24) pnpm --filter @lacrew/orchestrator dev

curl -s http://127.0.0.1:8788/intents \
  -H "authorization: Bearer $LACREW_ORCH_TOKEN" | jq .
```

`GET /health` reports `auth.required` so clients can detect the mode. The
lacrew.xyz API forwards the same `LACREW_ORCH_TOKEN` env automatically; the
example crews send it when `ORCH_TOKEN` is set. Always set the token when the
port is reachable beyond localhost.

## Docker (orchestrator)

```bash
# From lacrew repo root
docker build -f packages/orchestrator/Dockerfile -t lacrew-orchestrator .
docker run --rm -p 8788:8788 lacrew-orchestrator
# Or via lacrew.xyz infra: docker compose --profile orch up -d
```

## Upgrade path

1. Keep `DATABASE_URL` stable across releases — `@lacrew/db` and cloud tenancy migrations are additive SQL.
2. After pulling: `pnpm install && pnpm build && pnpm db:migrate` (and `pnpm --filter @lacrew.xyz/tenancy db:migrate` when running the cloud API).
3. Re-run `lacrew deploy --anvil` (or Sepolia) only when contract ABIs change; sync with `pnpm --filter @lacrew/core sync-abis`.
4. Orchestrator HTTP is additive (`/health` fields grow; old clients ignore unknowns).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `GET /health` → `mode: "mock"` | Set `ANVIL_RPC` + `PRIVATE_KEY`; ensure Anvil is up and `31337.json` exists |
| `queue.provider` not `pg-boss` | `DATABASE_URL` unset or Postgres down; `pnpm db:up` then migrate |
| `EADDRINUSE :8788` | Another orchestrator still running — kill the old process after `tsx` reloads |
| Propose reverts / no session | `POST /boot` first; confirm SessionRegistry grants for the worker |
| `401 unauthorized` | `LACREW_ORCH_TOKEN` set on the orchestrator — send `Authorization: Bearer <token>` (cloud API and examples read the same env) |
| Cloud API `notification_prefs` missing | API now auto-migrates on boot; or run `pnpm --filter @lacrew.xyz/tenancy db:migrate` |

## Cloud pairing (lacrew.xyz)

Run the public orchestrator on `:8788`, then the private API on `:8789` and web on `:3000`. See the lacrew.xyz README for `file:` package wiring. The API applies tenancy SQL migrations on startup when `DATABASE_URL` is set.

## TODO

- TODO: Publish `@lacrew/sdk` / `@lacrew/orchestrator` / `@lacrew/db` to npm
- TODO: Full Ponder + Postgres indexer (Phase 1)
- TODO: Docker image for the orchestrator (F2.9 / F2.16)
