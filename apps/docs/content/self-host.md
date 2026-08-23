---
title: "Self-hosting"
---

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

### A second human on Anvil

Two humans is the shape agency partners and clubs run: either can veto, firing
one leaves the other, and firing the last is refused onchain. Two ways to stand
it up locally.

**At deploy time** — `SECOND_HUMAN` seats a peer as part of `DeployMockOrg`.
Anvil account #2 is the natural second key:

```bash
# Terminal B, instead of the plain deploy above
SECOND_HUMAN=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
  pnpm --filter @lacrew/cli exec tsx src/index.ts deploy --anvil

# Both seats, plus the quorums execute() actually gates on
pnpm --filter @lacrew/cli exec tsx src/index.ts gov seats --rpc http://127.0.0.1:8545
```

The script does not write the seat directly — it cannot. It passes a High-tier
proposal on the module, which the root clears alone only because it is still the
whole human electorate (the unanimity fast path). It also adds the partner as a
`HumanRoot` node under the root, which is how one org tree carries two humans.

**On a running org** — the same thing by hand, as a partner would actually be
admitted once the org already has humans in it:

```bash
RPC=http://127.0.0.1:8545
PARTNER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

# 1. Propose (always high tier — the module refuses seat admin from any key)
pnpm --filter @lacrew/cli exec tsx src/index.ts gov admit-human $PARTNER 2 --rpc $RPC
# 2. Every seated human votes; then execute
pnpm --filter @lacrew/cli exec tsx src/index.ts gov vote <id> yes --rpc $RPC
pnpm --filter @lacrew/cli exec tsx src/index.ts gov execute <id> --rpc $RPC
```

With two seats, `PRIVATE_KEY` set to either human can `gov veto <id>` a
high-tier proposal — that is the shared safety valve, and it needs no quorum and
no waiting. `gov remove-human <partner>` runs the same propose/vote/execute
loop in reverse; aimed at the last remaining human it reverts `LastHumanSeat`,
so the org can never end up with agent seats as its only electorate.

Not covered by this: the org wallet. The session issuer and Safe still key off
one root address in v1 — a second human is a governance peer, not a co-signer.
See [Security model](./protocol/security.md).

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

`POST /governance/attach-policy-module` installs a marketplace policy-module
listing: it revalidates the payload, resolves the module for this chain (an
explicit `deployments` address, or a `standardModule` from your own address
book), refuses an address with no code, **appends** it to the stack the router
binds for the node today, and proposes the bind at the high tier. It never
calls `setNodePolicy` itself — buying a module grants a payload, binding it is a
vote — and it returns `alreadyBound: true` without proposing when the node
already carries the module. 409 means this deployment has no chain, so nothing
could honestly be proposed.

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
(`orchestrator_flows` / `orchestrator_flow_runs`), in-flight run state and its
checkpoints (`orchestrator_flow_run_state` /
`orchestrator_flow_checkpoints` — what lets a run pause, survive a restart, and
resume without repeating a write; see
[run lifecycle](./flows.md#run-lifecycle--pause-resume-cancel)), and session/intent records
(`orchestrator_sessions` / `orchestrator_intents` — metadata only, session
private keys never leave the process). `GET /sessions/history` and
`GET /intents/history` read them back; without a database the same endpoints
serve a bounded in-memory ring.

Blueprint seat bindings (`orchestrator_crew_bindings`) live here too — see
[naming the seats](./crews.md#naming-the-seats).

Those round trips are checked against a real database in CI (the **Stores
(Postgres)** job), not only against the memory fallback: the in-memory store
holds each record whole, so a column the row mapping forgets to write survives
there no matter what it does. To run them locally, point `DATABASE_URL` at a
migrated database and the store tests stop skipping:

```bash
DATABASE_URL=postgres://lacrew:lacrew@localhost:5432/lacrew \
  pnpm --filter @lacrew/orchestrator exec node --import tsx --test \
  src/crewBindings.test.ts src/auditStore.test.ts src/runtimeStore.test.ts
```

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

### Root-anchored revoke, rotate, and root-depth approvals

Out of the box those routes are open to anyone who can reach the orchestrator. Set `LACREW_ROOT_AUTH` and they demand a fresh proof from the workspace root instead — the orchestrator mints the challenge and checks the answer itself, so nothing in front of it (a control plane, a reverse proxy, a stolen cookie) can stand in for the human.

Three kinds of root, matching the account kinds in F1.3:

```bash
# A wallet root (injected EOA / hardware wallet)
export LACREW_ROOT_AUTH=wallet
export LACREW_ROOT_ADDRESS=0x…            # must be SessionRegistry.humanRoot

# A passkey root that signs, while some other address sends
export LACREW_ROOT_AUTH=passkey
export LACREW_ROOT_PASSKEY_ID=…           # base64url credential id
export LACREW_ROOT_PASSKEY_PUBKEY=…       # base64url COSE public key from registration
export LACREW_ROOT_PASSKEY_RPID=localhost
export LACREW_ROOT_PASSKEY_ORIGIN=http://localhost:3000

# A passkey-owned Safe — the default root kind, and the only one where the
# root address is itself the sender the chain sees on `resolve`
export LACREW_ROOT_AUTH=safe-passkey
export LACREW_ROOT_PASSKEY_ID=…           # …plus the four passkey values above
export LACREW_ROOT_SAFE_ADDRESS=0x…       # the deployed Safe the credential owns
```

Check what a deployment actually enforces before trusting it:

```bash
curl -s http://127.0.0.1:8788/health | jq .rootAuth
lacrew session status
```

`required: false` means revoke is ungated here. A `configError` means a root was configured but cannot verify anything — the gated routes refuse until it is fixed, rather than quietly falling open.

#### Approvals that reached the root

`EscalationRouter.resolve` already reverts for any sender that is not the intent's `awaitingApprover`. What the orchestrator adds is the half the chain cannot see: when the waiter is the human root, holding the orchestrator's bearer token is not being the root. Without that check, any deployment whose keyring happens to include the root key — every Anvil fixture, and any self-host that put root in `PRIVATE_KEY` — would let a token spend the root's reserved authority, and the receipt would name the root as the approver.

Ask whether one intent needs the root before you build a button for it, because the answer is per-intent:

```bash
curl -s -X POST http://127.0.0.1:8788/root-auth/challenge \
  -H 'content-type: application/json' \
  -d '{"action":"intent:approve","subject":"12"}' | jq .
```

`required: false` comes back for a manager-depth intent, with the seat that _is_ waiting on it. Demanding the root's authenticator for a spend inside a manager's own bounds would make the reporting tree decorative — and a prompt that is not really required is one operators learn to click through.

When it is required, send the proof with the decision:

```bash
curl -s -X POST http://127.0.0.1:8788/intents/resolve \
  -H 'content-type: application/json' \
  -d '{"intentId":"12","approved":true,"challenge":"…","rootProof":{…}}' | jq .
```

The reply carries `approver` (the seat that signed, read off the chain) and `authorizedBy` (`root:passkey`, `root:safe-passkey`, `root:wallet`, `approver`, or `unauthenticated` when no root is configured). `@lacrew/sdk` wraps the exchange:

```ts
import { approveIntent } from "@lacrew/sdk";

await approveIntent({ intentId: "12", rootAccount }); // wallet root, signs locally
await approveIntent({ intentId: "12", proof: assertion }); // passkey root, signed at the authenticator
```

Two things it will not do: resolve as the root without a proof, and resolve an intent the chain does not have pending — "we could not find it" must never fall through to "no proof needed".

#### When the root is a Safe

`LACREW_ROOT_AUTH=passkey` proves who the root is. It does not make the root the sender: some address the deployment holds a key for still submits `resolve`, and the chain sees that address. For a Safe root that is not good enough — the Safe _is_ the org's root address, so anything else is a different account moving the money with the root's blessing.

`safe-passkey` closes that. Approving builds a Safe transaction that calls `resolve`, and the Safe sends it:

```
challenge  = the Safe transaction's own EIP-712 hash
assertion  = one navigator.credentials.get() over that hash
             ├── the orchestrator verifies it against the registered COSE key
             └── the Safe's SafeWebAuthnSigner verifies it inside execTransaction
resolve    = msg.sender is the Safe
```

One ceremony, two verifiers. Two separate ones would be two consents that can disagree, which is one consent that can be swapped.

Consequences worth knowing:

- **The ceremony must use `userVerification: "required"`.** Safe's signer contract demands the flag; an assertion without it passes every off-chain check and then reverts inside `execTransaction`. The challenge response says `userVerification: "required"` for this reason, and the orchestrator refuses such a proof rather than broadcasting it.
- **The challenge is not reusable and not ours to invent.** It folds in the Safe's live nonce, so any other Safe transaction that lands first invalidates it.
- **Deploying the Safe conferred no ownership.** Before every approval the orchestrator re-reads the Safe and refuses unless it is 1-of-1 owned by the signer this credential implies.
- **Gas is a separate decision from authority.** Nothing here is paid for by the root.

Who broadcasts is two deliberate settings, with no default — a relayer set up for a local chain must not become a mainnet sender because a chain id changed:

```bash
export LACREW_ROOT_APPROVAL_RELAYER=0x…          # a funded key; authorizes nothing
export LACREW_ROOT_APPROVAL_RELAY_CHAINS=31337   # the only chains it may spend on
```

With no relayer for the chain, `/intents/resolve` answers `409 safe_exec_unsigned` and hands back the built transaction for your own wallet to send. Nothing is recorded then — handing someone a transaction is not a spend that happened — so tell the orchestrator once it lands, and it re-reads the chain before writing anything.

In the cloud Approvals inbox this is one press: the row keeps the signed approval and offers "Connect a wallet and send", which connects, broadcasts, and confirms. Approve and Deny disappear from that row while it stands, because the decision is already signed and offering them again would ask for the same consent twice. Driving it yourself:

```bash
curl -s -X POST http://127.0.0.1:8788/intents/confirm \
  -H 'content-type: application/json' \
  -d '{"intentId":"12","approved":true,"txHash":"0x…"}' | jq .
```

`confirmed: false` with an `awaitingApprover` means the router still awaits the Safe: the transaction did not land, and nothing was written.

##### The recipe, on Anvil

```bash
# 1. A chain with Safe's singletons and passkey module on it.
anvil --port 8546 --fork-url https://mainnet.base.org

# 2. Derive and deploy the root Safe from the registered credential
#    (Settings → Root account in the cloud app, or @lacrew/adapter-wallet-safe
#    directly: deployRootSafe → relayRootSafeDeployment → verifyRootSafeDeployed).

# 3. Point the orchestrator at it, and let it relay on this chain only.
export LACREW_ROOT_AUTH=safe-passkey
export LACREW_ROOT_SAFE_ADDRESS=0x…            # the deployed Safe
export LACREW_ROOT_PASSKEY_ID=… LACREW_ROOT_PASSKEY_PUBKEY=…
export LACREW_ROOT_PASSKEY_RPID=localhost LACREW_ROOT_PASSKEY_ORIGIN=http://localhost:3000
export LACREW_ROOT_APPROVAL_RELAYER=0x…        # an anvil dev key
export LACREW_ROOT_APPROVAL_RELAY_CHAINS=31337

# 4. Escalate something past the worker's cap, then approve it as the Safe.
lacrew intents list
lacrew intents approve 12                      # prints the hash to sign, and stops
lacrew intents approve 12 --root-proof '{"kind":"passkey","credentialId":"…","authenticatorData":"…","clientDataJSON":"…","signature":"…"}'
```

The whole loop — deploy the passkey Safe, bootstrap the org through it, escalate, approve as the Safe, watch USDC land on the target, and watch a different credential's assertion revert with the funds unmoved — is asserted end to end by `packages/adapters/wallet-safe/src/safeRootApprove.test.ts` against a fork.

#### The recipe, on Anvil

With a wallet root, the CLI runs the whole exchange:

```bash
export ROOT_PRIVATE_KEY=0x…              # the root wallet; signs the challenge locally
lacrew session revoke 7                  # → challenge → personal_sign → onchain revoke
lacrew session rotate 7                  # → same proof, then re-issue under key 7's bounds
```

With a passkey root there is no key this terminal can sign with, so collect the assertion where the authenticator is and hand it over:

```bash
lacrew session revoke 7 --root-proof '{"kind":"passkey","credentialId":"…","authenticatorData":"…","clientDataJSON":"…","signature":"…"}'
```

Under the hood that is two calls, if you would rather drive them yourself:

```bash
curl -s -X POST http://127.0.0.1:8788/root-auth/challenge \
  -H 'content-type: application/json' \
  -d '{"action":"session:revoke","subject":"7"}' | jq .

curl -s -X POST http://127.0.0.1:8788/sessions/revoke \
  -H 'content-type: application/json' \
  -d '{"sessionId":"7","challenge":"…","rootProof":{…}}' | jq .
```

Rules worth knowing before you build on it:

- A challenge is **single-use, expiring (5 min), and bound to one action on one subject**. A proof collected to revoke key 7 will not revoke key 8, and will not rotate key 7 — rotation re-issues authority, revocation only removes it. An assertion collected to approve intent 12 will not deny it, and will not settle intent 13.
- A failed attempt burns the challenge too, so a bad proof cannot be ground against a live nonce.
- **Rotation reads its bounds from the chain**, never from the request: the replacement carries the retired key's agent, scopes, `maxValue`, pinned targets, window, and rate limit. It can come back narrower (the deployment's own ceiling still applies); it cannot come back wider.
- `{"containment": true}` on `/sessions/revoke` skips the proof. It is reserved for automated narrowing — a guardian lockdown, an agent pause — can only ever _take_ authority away, is refused outright by rotate, and is audited as `authorizedBy: "containment"` so the trail never reads as though a root signed.

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

## Deploying a passkey root Safe

A Safe-with-passkey root is deterministic before it exists: the credential implies a `SafeWebAuthnSigner` address, and that signer implies a 1-of-1 Safe. `predictPasskeySafe` answers both, and the address is real and fundable while still counterfactual — most roots never need more than that, since a Safe deploys with its first transaction.

Deployment is the step that puts code at those two addresses, and it needs a sender with gas. Two modes, and which one you are in is a different call rather than a flag:

```ts
import { deployRootSafe, relayRootSafeDeployment, verifyRootSafeDeployed } from "@lacrew/adapter-wallet-safe";

// Builds only. `txs` is what is still outstanding, in order — an already
// deployed root comes back with an empty list, not an error.
const plan = await deployRootSafe(publicClient, {
  provider: rpcUrl,
  publicKey: coseKeyFromRegistration,
  saltNonce: workspaceId,
});
```

**The default sender is the user's own wallet.** Hand `plan.txs` to whatever the human already holds — MetaMask, a hardware wallet — and no key beyond theirs is involved in establishing their root. Deploying does not confer ownership: the owner is the signer the credential implies, whoever paid the gas.

**A relayer is opt-in and allowlisted.** `relayRootSafeDeployment` broadcasts with a key you supply, and only for chain ids you name:

```ts
const relayed = await relayRootSafeDeployment({
  provider: rpcUrl,
  privateKey: process.env.LACREW_ROOT_DEPLOY_RELAYER as `0x${string}`,
  allowChainIds: [31337],   // no default; an empty list refuses everything
  plan,
});
```

There is no "unless it looks like mainnet" heuristic, because an allowlist that has to be passed in is the only version an operator cannot end up with by accident. Public-network gas is a separate ops decision this path deliberately does not make for you — it will refuse a chain you did not name, whatever the balance on the key.

Either way, confirm rather than assume. A landed transaction is not the same claim as a passkey-owned root:

```ts
const check = await verifyRootSafeDeployed({
  provider: rpcUrl,
  safeAddress: plan.predicted.safeAddress,
  expectedOwner: plan.predicted.ownerAddress,
});
// check.deployed    → there is code at the predicted address
// check.ownerMatches → it is 1-of-1 owned by the passkey signer, not the sender
// check.reason      → why not, when either is false
```

### The recipe, on Anvil

Anvil's prefunded accounts are the sender, and a fork carries the canonical Safe singletons and passkey module that a bare chain does not have. Nothing is published:

```bash
anvil --port 8546 --fork-url https://mainnet.base.org

SAFE_FORK_RPC=http://127.0.0.1:8546 \
SAFE_FORK_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  pnpm --filter @lacrew/adapter-wallet-safe test
```

That suite drives the whole loop — predict, relay, `getCode` at the predicted address, live owners read back as the passkey signer — plus the refusals: an unconfigured relayer stops before it reaches an RPC, and a chain outside the allowlist sends nothing at all.

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

## Inference cost budgets

What those model calls may cost you is bounded separately from what a crew may
spend onchain — the policy stack sees no tokens, and a heartbeat on a frontier
model can outspend the desk while every onchain number reads healthy.

```bash
lacrew budget set --crew trading --usd 200 --hard --enable
lacrew budget usage --crew trading      # the calls behind the number
curl -s http://127.0.0.1:8788/health | jq .budgets
```

`LACREW_MODEL_PRICES` overrides the built-in price table with your negotiated
rates, as `{"<model-prefix>":{"inputPerMTok":n,"outputPerMTok":n}}`. Unset, the
shipped list prices are used and anything unmatched is counted as **unpriced**
rather than free. Counters live in Postgres when `DATABASE_URL` is set — without
it they are per-process and do not survive a restart, which is fine for one node
and not for a fleet. See [Inference cost budgets](./inference-budgets.md).

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

## Is the crew actually working?

Every surface above answers a piece of the question. `crews checklist` asks all
of it at once, against this orchestrator, and exits non-zero while anything
stands in the way:

```bash
ORCH_URL=http://127.0.0.1:8788 lacrew crews checklist github-experts
```

It needs no `--bind` flags once this orchestrator knows which account each seat
landed on. Record that once, right after the install, while the labels and the
blueprint still agree:

```bash
lacrew crews bind github-experts --from-org   # persist what a label match found
lacrew crews bind github-experts              # what is stored, seat by seat
```

The mapping lives in the orchestrator's own store — Postgres when
`DATABASE_URL` is set, memory otherwise — and is hydrated at boot, so it
survives a restart and does not depend on you still having the plan file you
installed from. `GET /org` then carries a `roleId` on every bound seat, and a
seat renamed afterwards still resolves. Details, including what the record is
_not_, are in [Crew blueprints](./crews.md#naming-the-seats).

`pnpm golden-path` goes further: it stands the whole stack up on Anvil, hires
seats through real governance proposals, registers the `github` preset against a
local stand-in host, and asserts the checklist clears — with the runtime
asserted `onchain` first, so a green result cannot come from mock mode.

Four blueprints are certified, and they are four different setup burdens — run
the one that matches what you have:

```bash
pnpm golden-path                               # github-experts: a connector, a credential, an address
pnpm golden-path --blueprint content-studio    # needs only a model key
pnpm golden-path --blueprint governance-desk   # a connector, but a public one that takes no key
pnpm golden-path --blueprint defi-desk         # only a model key, and the run changes seats mid-way
```

All four are documented in
[Crew blueprints](./crews.md#the-first-run-on-your-own-anvil).

## External MCP servers

`LACREW_MCP_SERVERS` attaches third-party MCP servers — the ones you already run
for GitHub, a browser, a database. Attaching one admits nothing: every tool
starts blocked, including tools that appear on the server later, and an operator
allows them one at a time. See [External MCP servers](./external-mcp.md).

```bash
export LACREW_MCP_SERVERS='[{"id":"gh","transport":"http",
  "url":"https://mcp.example.com/rpc",
  "auth":{"kind":"bearer","tokenEnv":"GH_MCP_TOKEN"}}]'
export GH_MCP_TOKEN=…

lacrew mcp refresh                                # discovers, and blocks
lacrew mcp allow gh.search_issues --effect read   # admit one tool by name
lacrew mcp servers                                # what is allowed, and what is not
```

`LACREW_MCP_SERVERS` is re-read at every boot, so it is the right home for a
server you own. To attach one **without a restart** — and have it persist —
`lacrew mcp attach gh --endpoint https://… --token-env GH_MCP_TOKEN`. It admits
nothing either: discovery runs at once and records every tool blocked.

A **stdio** server is a subprocess of this orchestrator: code execution on this
machine, which is a reasonable trade when you own it. Its child gets only the env
vars you name in `env`, never this process's environment.

If this orchestrator serves more than one workspace, say so with
`LACREW_MCP_HOSTED=1`. Every default flips to deny: stdio is refused, loopback is
refused, and an http server may only live on a host in
`LACREW_MCP_ALLOW_HOSTS` — with no allowlist it reaches nothing. Private and
link-local addresses are refused in both modes, allowlist or not, because an
orchestrator can reach your database and your cloud's metadata service and an
attached URL is a request it makes on somebody else's say-so.

```bash
export LACREW_MCP_HOSTED=1
export LACREW_MCP_ALLOW_HOSTS='mcp.example.com,*.tools.example.com'
export LACREW_MCP_ALLOW_ENV='TENANT_MCP_*'   # env names a runtime attach may read
```

A workspace on such a worker cannot set an env var, so it stores its credential
in the orchestrator's sealed store instead and the config names _that_:

```bash
printf %s "$GH_TOKEN" | lacrew mcp secret set gh
lacrew mcp attach gh --endpoint https://mcp.example.com/rpc --secret-ref gh
```

Sealed under `LACREW_SESSION_KEY`, scoped to whoever wrote it, and never
returned by any route. Without that key the write is refused rather than stored
in cleartext.

## Plan-required mode

Off by default. Turn it on and a side effect refuses unless the acting agent has
already posted a `plan` in its thread saying what it is about to do — legible
first, autonomous second. It approves nothing: spends still meet the policy stack
and still escalate. See [Plan-required mode](./plan-required.md).

```bash
export LACREW_PLAN_REQUIRED=spends_only          # or side_effects
export LACREW_PLAN_REQUIRED_WINDOW_MIN=30        # how long a plan stays current

lacrew plan-required list                        # what is in force
lacrew plan-required set --crew 0xDESK --mode side_effects
```

Rules are stored in Postgres when `DATABASE_URL` is set. Unlike the allowlists
above, this one **fails open**: an unreadable rule set leaves crews working as
before, bounded by every onchain and connector control, and the orchestrator says
so loudly at boot.

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

Two more things hold the line between "an operator's orchestrator on
localhost" and "a mutation any web page the operator visits can make", and they
hold whether or not a token is set:

- **No wildcard CORS.** Responses carry `access-control-allow-origin` only for
  an origin listed in `LACREW_ORCH_CORS_ORIGINS` (comma-separated). Unset means
  no browser origin may read a response or pass a preflight. The CLI, the SDK
  and the cloud control plane are not browsers and need nothing here.
- **Mutations are JSON.** A `POST`/`PUT`/`PATCH`/`DELETE` that carries a body
  must say `content-type: application/json`, or it is answered `415`. A
  cross-site form or a `fetch` with a text body is a "simple request" the
  browser sends without a preflight; requiring a JSON content type turns it
  into one that needs the preflight above. `POST /hooks/:triggerId` is exempt
  (producers authenticate by HMAC).

`LACREW_ORCH_HOST=127.0.0.1` narrows the bind address for a laptop demo; unset
binds every interface, which containers and pools rely on. Without a token the
process says so at boot.

`POST /hooks/:triggerId` is the one exception besides `/health`, and it is not
an open route: a webhook producer is an external system holding that trigger's
HMAC secret rather than the operator's bearer token, and every delivery is
verified against that signature before anything is enqueued. See
[Webhook triggers](./flows.md#webhook-triggers).

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
| `415 content_type_must_be_json`                  | A mutating request carried a body without `content-type: application/json` — set the header (browsers: see HTTP auth)              |
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
