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

# Optional: lightweight event indexer for audit / pending intents.
# With DATABASE_URL set it also writes orchestrator_audit_events (the stable
# consumer schema) and backfills history from block 0 on start — idempotent,
# deduped on (tx_hash, log_index). INDEXER_BACKFILL=0 disables backfill;
# INDEXER_FROM_BLOCK sets the start block.
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

### Read surface (chain-truth endpoints)

Every read answers from the chain (or the persisted trail) — mock mode serves
`[]`, never fixtures; the unavailable app answers 503, never an empty org:

| Endpoint                 | What it reads                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /policies`          | Per-node policy stacks: the module the router binds per node, each module's kind and enforced params (`?node=`, `?asset=` for a non-primary stack's own router)                                                  |
| `GET /usage`             | Operation counts by audit-event type for a period (`?since=`, default the current UTC month). `complete: false` flags a memory-bounded ring — a partial count is never served as a total                         |
| `GET /assets`            | The asset stacks the org can budget in (primary first)                                                                                                                                                           |
| `GET /governance/grants` | Per-epoch grants on an asset's EpochStreamer (`?asset=`)                                                                                                                                                         |
| `GET /treasury/balances` | Real per-asset holdings from each Treasury                                                                                                                                                                       |
| `GET /agents/balances`   | What each node's own account holds — native float plus one row per address-book ERC-20 — grouped by chain. Distinct from allowances: this is the balance _in_ the account, not what the Treasury reserved for it |
| `GET /wallets/watchlist` | Chains and tokens balances are read on, RPC credentials masked                                                                                                                                                   |

### Wallet watchlist

`GET /agents/balances` reads the bound chain plus every chain on the watchlist.
A watched chain needs only an RPC endpoint, the account addresses, and the token
addresses — **no LaCrew deployment on that chain** — because an org's seats are
addresses that exist on any EVM chain.

Set `WALLET_WATCHLIST` to a JSON array (the cloud pushes the same shape to
`POST /wallets/watchlist`):

```bash
export WALLET_WATCHLIST='[
  {"chainId":8453,"rpcUrl":"https://base-mainnet.example/v2/KEY","tokens":[
    {"symbol":"USDC","address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","decimals":6}
  ]},
  {"chainId":42161,"tokens":[]}
]'
```

Each chain reports `read: true|false`. A chain with no `rpcUrl`, an unreachable
endpoint, or one whose `eth_chainId` disagrees with the entry is returned with
`read: false` and a reason — **never as accounts holding zero**. That
distinction is the point: a fabricated zero on a balance screen is worse than an
empty one. `@lacrew/core` ships `knownChains()` and `KNOWN_STABLECOINS` as a
pick-list so addresses need not be typed by hand; verify any mainnet address
against its issuer before relying on the figure.

### Governance write surface

`POST /governance/propose-node-stack` deploys a node's desired stack (fresh
rate/window modules with the requested params — their onchain params are
constructor immutables — reusing identical ones, shared whitelist/spend-cap
by address) and proposes `setNodePolicy` plus `setNodeRateRecorder` when the
stack carries its own rate module. An unchanged composition proposes nothing
(`unchanged: true`). `asset` selects a non-primary stack's own router;
`propose-set-whitelist` and `propose-set-agent-cap` take the same selector.

### Indexer-derived events

The indexer also derives `TreasuryDeposit` / `TreasuryOutflow` from each
token's own `Transfer` log filtered per treasury — a plain ERC-20 transfer
runs no treasury code, so the token log is the only onchain record money
moved. An outflow whose transaction matches no protocol spend is the theft
signal Guardian correlates on.

### Approval simulation

`GET /intents` enriches pending intents with the F1.16 simulation trio:
the policy verdict, `measuredChanges` (the approval executed in one
`eth_simulateV1` block, balances read from the world it would leave behind),
and `callTrace` (`debug_traceCall` callTracer — the exact contracts the
approval executes, revert named on its frame). Both are absent when the node
lacks the RPC — absent means "not measured/traced", never "no movement".

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

With `DATABASE_URL` set the orchestrator persists its restart-surviving state:
audit events (`orchestrator_audit_events`), flow definitions + runs
(`orchestrator_flows` / `orchestrator_flow_runs`), and session/intent records
(`orchestrator_sessions` / `orchestrator_intents` — metadata only, session
private keys never leave the process). `GET /sessions/history` and
`GET /intents/history` read them back; without a database the same endpoints
serve a bounded in-memory ring.

### More than one orchestrator per database

`DATABASE_SCHEMA` puts a runtime's tables in a Postgres schema of its own, so
one database can hold several orchestrators — a few environments on one box, or
a hosted pool running a separate runtime per workspace.

```bash
export DATABASE_URL=postgres://lacrew:lacrew@localhost:5432/lacrew
export DATABASE_SCHEMA=staging      # lowercase identifier; refused otherwise
pnpm --filter @lacrew/orchestrator dev
```

Leave it unset and everything stays in `public`, exactly as before. Set it and
the runtime creates the schema if it is missing, points `search_path` at it on
every connection, and keeps its **migration journal there too** — a journal left
in a shared schema would tell the second runtime that every migration had
already been applied, and it would boot against an empty schema.

This is namespacing, not a security boundary: every runtime still connects with
the same role and could read another schema if it asked. What it prevents is
runtimes silently sharing one set of tables, which for `orchestrator_audit_events`
means each one's audit trail contains the other's.

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

**Set `MANAGER_ADDRESS`.** On any chain other than 31337 the script defaults the
manager seat to a keyless placeholder address — fine for a read-only publish,
but escalations can never be approved. Point it at an address whose key you
hold (the orchestrator's `MANAGER_PRIVATE_KEY`) before deploying.

Override addresses via `LACREW_ORG_REGISTRY`, `LACREW_TREASURY`, `LACREW_ESCALATION_ROUTER`, etc.

### Rehearse the Sepolia path locally

The exact same flow can be dry-run against an Anvil wearing Sepolia's chain id
— useful before spending real testnet ETH:

```bash
anvil --chain-id 11155111 --port 8547   # terminal A

# terminal B — deploy exercises the non-Anvil path end to end
export SEPOLIA_RPC_URL=http://127.0.0.1:8547
export CHAIN_ID=11155111
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export MANAGER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
pnpm --filter @lacrew/cli exec tsx src/index.ts deploy

# smoke: org → epoch → escalate → approve (75 USDC lands at the x402 target)
export ANVIL_RPC=$SEPOLIA_RPC_URL
export MANAGER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
lacrew() { pnpm --filter @lacrew/cli exec tsx src/index.ts "$@"; }
lacrew org --rpc $SEPOLIA_RPC_URL
lacrew epoch --rpc $SEPOLIA_RPC_URL
lacrew tick --rpc $SEPOLIA_RPC_URL      # 75 USDC > 50 cap → ESCALATE
lacrew approve 1 --rpc $SEPOLIA_RPC_URL

# then discard the local artifacts — placeholders stay committed until a real deploy
git checkout -- contracts/deployments packages/core/deployments packages/core/src/deployments.generated.ts
rm -rf contracts/broadcast contracts/deployments/11155111.json
```

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

### Dedicated issuer key

`SessionRegistry.issue`/`revoke` accept root **or** a designated issuer. By default the orchestrator's `PRIVATE_KEY` signs issuance, but on a real chain that key should not be root. Set `LACREW_ISSUER_PRIVATE_KEY` to a dedicated key so the orchestrator can mint bounded, expiring session keys without holding root:

```bash
export LACREW_ISSUER_PRIVATE_KEY=0x…   # the key the orchestrator holds
```

On a local chain where `PRIVATE_KEY` is root, the orchestrator authorises this key at boot (`setIssuer`). On a real chain, root authorises it out of band — from the root wallet — and the orchestrator holds only the issuer key:

````bash
# PRIVATE_KEY here is root; run once to authorise the issuer address.
lacrew session-set-issuer 0x<issuer address> --rpc
lacrew session-issuer --rpc   # read it back
``` A compromise of that key can issue session keys (already bounded by scope, `maxValue`, and expiry the chain enforces) but cannot change the issuer, move the treasury, or touch governance; only root can `setIssuer`.

## Model provider

Orchestrator model calls go through `ModelProvider` (never a hard-wired vendor SDK):

```bash
# Memory stub (default)
curl -s -X POST http://127.0.0.1:8788/model/complete \
  -H 'content-type: application/json' \
  -d '{"prompt":"Summarize pending escalations"}' | jq .

# Anthropic, OpenAI, or OpenRouter once a key is set — see .env.example.
# First key wins in that order; LACREW_MODEL_PROVIDER pins one explicitly.
curl -s http://127.0.0.1:8788/health | jq .model
````

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

## Connectors

`LACREW_CONNECTORS` (inline JSON or a path to a JSON file) registers the
external surfaces your flows may call — GitHub, a CMS, an RPC. Routes are an
allowlist, credentials come from the environment, writes can be gated on the
policy stack, and every call lands on the audit trail. See
[Connectors](./connectors.md). Unset, crews run with no external reach, which is
the default rather than an error.

Vetted definitions ship for the surfaces the first-party crews work in, so the
common case is not hand-written JSON:

```bash
lacrew connectors list
export LACREW_CONNECTORS="$(lacrew connectors config github \
  --policy-target merge_pull_request=0xMERGE_AUTHORITY)"

# GitHub's default mode is an App installation — scoped to the repos it was
# installed on, and revocable without touching anyone's own access.
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY="$(cat lacrew-crew.private-key.pem)"
export GITHUB_APP_INSTALLATION_ID=48213991
```

`GET /connectors` reports what is registered, which env vars each connector
reads and whether they are set — never a value.

## Skill packs

A pack is the procedure half of a vertical: named skills, each with a trigger,
installed onto a seat's directive. Nothing about it is authority — it is
instruction, and an install refuses outright when the flows, connector routes or
tools it names are not registered here. See [Skill packs](./skill-packs.md).

```bash
lacrew skills list --url http://127.0.0.1:8788   # ✓/✗ per pack, with what is missing
lacrew skills install github-pr-triage --agent 0xSEAT
lacrew skills installed --agent 0xSEAT
```

Directives are stored in Postgres when `DATABASE_URL` is set, so an installed
pack survives a restart; without it, it lives as long as the process does.

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

`POST /hooks/:triggerId` is the one exception besides `/health`, and it is not
an open route: a webhook producer is an external system holding that trigger's
HMAC secret rather than the operator's bearer token, and every delivery is
verified against that signature before anything is enqueued. See
[Webhook triggers](/docs/flows#webhook-triggers).

## Webhook triggers (self-host)

The hook surface lives on the public orchestrator, so event-driven crews do not
need the cloud. Two env vars shape it:

| Var                            | Default   | Purpose                                                                                                                                                                                                              |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LACREW_SESSION_KEY`           | unset     | Seals trigger secrets at rest (`openssl rand -base64 32`). Required once `DATABASE_URL` is set — minting a trigger without it fails `webhook_sealing_unavailable` rather than writing a cleartext secret to Postgres |
| `LACREW_WEBHOOK_MAX_BYTES`     | `1048576` | Body cap; an oversized delivery is refused on its declared `content-length` before it is buffered                                                                                                                    |
| `LACREW_WEBHOOK_TOLERANCE_SEC` | `300`     | Replay window for the timestamped `lacrew` scheme                                                                                                                                                                    |

Three event sources ship: `lacrew` and `github` verify an HMAC over the raw
bytes; `google-pubsub` verifies a Google-signed OIDC token instead, binding to
the `audience` and `serviceAccountEmail` the trigger was created with. That
binding is what makes it safe — anyone can have Google sign a token for their
own service account, so the signature alone authorizes nothing. Google's key set
is fetched and cached; an unreachable one answers 503 rather than failing a
delivery closed.

Everything is drivable from the CLI (`lacrew flows triggers …`), so the cloud UI
is a convenience rather than a requirement.

With `DATABASE_URL` set, deliveries are dispatched through pg-boss and the
`(trigger_id, delivery_key)` unique index makes a redelivery a no-op across
replicas. Without one, triggers live in the process and do not survive a
restart — the honest single-node behaviour, not a silently degraded queue.

## Governance auto-execute (opt-in)

By default a proposal that has cleared its quorum — and, for high tier, its
timelock or the unanimity fast path — still waits for an operator to call
execute. Set `LACREW_AUTO_EXECUTE=1` and the orchestrator executes it on the
next minute sweep (the same queue-dispatched tick cron flows use, so a
multi-replica deployment fires it once, not once per replica).

Off by default on purpose: executing governance without a human press is a
policy decision. The sweep mirrors the contract's acceptance rules only to
avoid burning gas on reverts — the chain stays the enforcer, and the sweep
never spends gas to finalize a defeated ballot. `/health` and the boot log
report `gov-auto-execute=on` when enabled.

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

| Symptom                                          | Check                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health` → `mode: "mock"`                   | Set `ANVIL_RPC` + `PRIVATE_KEY`; ensure Anvil is up and `31337.json` exists                                                        |
| `queue.provider` not `pg-boss`                   | `DATABASE_URL` unset or Postgres down; `pnpm db:up` then migrate                                                                   |
| `EADDRINUSE :8788`                               | Another orchestrator still running — kill the old process after `tsx` reloads                                                      |
| Propose reverts / no session                     | `POST /boot` first; confirm SessionRegistry grants for the worker                                                                  |
| `401 unauthorized`                               | `LACREW_ORCH_TOKEN` set on the orchestrator — send `Authorization: Bearer <token>` (cloud API and examples read the same env)      |
| `webhook_sealing_unavailable` on trigger create  | `DATABASE_URL` set without `LACREW_SESSION_KEY` — generate one with `openssl rand -base64 32` and restart                          |
| Webhook delivery `401 webhook_signature_invalid` | Signature computed over re-serialized JSON; sign the exact bytes sent, and check the scheme matches how the trigger was registered |
| Cloud API `notification_prefs` missing           | API now auto-migrates on boot; or run `pnpm --filter @lacrew.xyz/tenancy db:migrate`                                               |

## Cloud pairing (lacrew.xyz)

Run the public orchestrator on `:8788`, then the private API on `:8789` and web on `:3000`. See the lacrew.xyz README for `file:` package wiring. The API applies tenancy SQL migrations on startup when `DATABASE_URL` is set.

To supervise a crew from Slack or Telegram, the control plane also needs a channel signing
key — `LACREW_CHANNEL_SECRET`, or `LACREW_SESSION_KEY`, from which one is derived. Without
it a reply from chat has no verifiable target and the bridge refuses rather than guessing
at a thread. See [Supervising a crew from chat](./chat-bridge.md).

## TODO

- TODO: Publish `@lacrew/sdk` / `@lacrew/orchestrator` / `@lacrew/db` to npm
- TODO: Full Ponder + Postgres indexer (Phase 1)
- TODO: Docker image for the orchestrator (F2.9 / F2.16)
