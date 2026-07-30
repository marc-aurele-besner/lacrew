# Connectors

A crew's work happens somewhere else. The dev crew's PRs are on GitHub, the
content crew's drafts are in a CMS, the trading desk's pools are behind an RPC.
Flows could only call the nine `lacrew_*` tools, so a crew could reason about
text handed to it and gate a spend — and stop at the edge of the thing it exists
to do.

A **connector** is an HTTP surface the operator registers with the orchestrator.
Flows call its routes by name (`github.get_pull_request`), and everything else
about the call is the operator's decision, not the flow's.

## Start from a preset

Some connectors ship. A preset is the definition written out once and tested —
base URL, paths, methods, and the arg allowlist for each route — so registering
one is a decision rather than a transcription. See what ships:

```bash
lacrew connectors list
lacrew connectors show github
```

A preset never carries a credential, and it will not guess a write's
`policyTarget` — that address only exists once the crew is stood up. Bind it and
emit the config:

```bash
lacrew connectors config github --policy-target merge_pull_request=0xMERGE_AUTHORITY
```

## Credentials: prefer an App to a personal token

A preset can declare more than one way to authenticate, listed best-posture
first. The first is what you get if you do not choose.

For GitHub that is a **GitHub App installation**, and the difference is not
stylistic:

| | Personal access token | App installation |
| --- | --- | --- |
| Reach | whatever its owner can reach | only the repos the App was installed on |
| Attribution | every crew action is a person's | the App's own identity in GitHub's audit log |
| Revocation | takes away that person's access too | uninstall, nobody else affected |

An App credential is not a static string. You hold an app id and an RSA private
key; the API wants an installation token that expires hourly. The registry does
that exchange itself — it signs a short-lived RS256 JWT as the app, trades it at
`/app/installations/{id}/access_tokens`, caches the result until five minutes
before expiry, and re-mints once if a call comes back 401. The private key never
leaves the process, and the installation token is never logged, never audited,
and never returned to a flow.

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="$(cat lacrew-crew.private-key.pem)"   # literal \n also accepted
GITHUB_APP_INSTALLATION_ID=48213991
```

Reach for the token mode when you are trying something out, or when an App is
more setup than the job deserves:

```bash
lacrew connectors config github --auth token \
  --policy-target merge_pull_request=0xMERGE_AUTHORITY
```

Ask for the merge route without an address and the command refuses rather than
printing config that would stop the orchestrator at boot. A crew that only reads
should leave the write out entirely — `--omit merge_pull_request` needs no
address, and the narrowest connector that does the job is the one to register.

`LACREW_CONNECTORS` also takes the reference directly, so the definition stays
in one place:

```json
[{ "preset": "github", "policyTargets": { "merge_pull_request": "0x…" } }]
```

Alongside `policyTargets` and `omitRoutes`, a reference accepts `baseUrl` (a
self-hosted instance such as GitHub Enterprise), `tokenEnv`, `credentialHeader`,
`timeoutMs`, and `id`. A preset expands to a plain connector and is validated
identically — it saves the copying, not the operator's decision.

### What ships

Every write below needs a policy target bound before it will register, and every
preset can be registered read-only with `--omit`. `lacrew connectors show <id>`
prints the routes, the args each takes, the credential modes it supports, and
what is still unbound.

| Preset | What a crew uses it for | Writes (need an address) | Credential modes |
| --- | --- | --- | --- |
| `github` | Pull requests, files, combined status, check runs | `merge_pull_request` | `github-app` (default) · `token` → `GH_TOKEN` |
| `gitlab` | Merge requests, diffs, pipelines — gitlab.com or self-hosted | `merge_merge_request` | `token` → `GITLAB_TOKEN` (`PRIVATE-TOKEN`) |
| `npm` | Published versions, dist-tags, deprecations | — | `none` |
| `pypi` | Release history, requires-python, yanked releases | — | `none` |
| `twitter` | Search, timelines, one post | `create_tweet` | `token` → `TWITTER_BEARER_TOKEN` |
| `typefully` | Draft queue and scheduling | `schedule_draft` (`create_draft` files a draft and needs none) | `token` → `TYPEFULLY_API_KEY` |
| `ghost` | The site's posts; files new ones | `create_post`, `update_post` | `token` → `GHOST_ADMIN_TOKEN` |
| `medium` | Alternate publish surface | `create_post` | `token` → `MEDIUM_INTEGRATION_TOKEN` |
| `notion` | Brand voice docs and past posts, read-only | — | `token` → `NOTION_TOKEN` |
| `uniswap` | Pool state and liquidity via the v3 subgraph | — | `token` → `GRAPH_API_KEY` |
| `tenderly` | Dry-run a call before proposing it | — | `token` → `TENDERLY_ACCESS_KEY` |
| `coingecko` | Prices and market context | — | `token` → `COINGECKO_API_KEY` |
| `defillama` | Protocol and chain TVL — money leaving before a headline says so | — | `none` |
| `defillama-yields` | Pool-level APY and its history | — | `none` |
| `aave` | Aave v3 reserve data: supply and borrow rates, liquidity, caps | — | `none` |

GitHub is the only one that offers an App today, and it is the only one whose
service supports the shape. Where a service has something closer to it than a
personal token — GitLab's project access tokens, Notion's integration secrets,
scoped to what is shared with them rather than to a person — the preset's note
says so, so the choice is on screen when you make it.

Four things worth reading off that table:

**No DeFi preset has a write at all.** A swap, or a supply into a lending
market, is an onchain intent that goes through `lacrew_propose_intent` and the
policy stack. A connector that could execute one would be a second execution
path with none of that enforcement, so `uniswap`, `tenderly`, `coingecko`,
`defillama`, `defillama-yields` and `aave` read and simulate, and nothing else.

**DefiLlama is two presets because it is two hosts.** A connector has exactly
one base URL, and DefiLlama serves TVL from `api.llama.fi` while yields live on
`yields.llama.fi` — `api.llama.fi/pools` is a 404. Folding them together would
ship a route that fails in the middle of a run, which is the transcription
mistake presets exist to prevent, so they are separate and a test pins the two
base URLs apart.

Two of those routes are bulk: `defillama.list_protocols` is around eight
megabytes and `defillama-yields.list_pools` around eleven. Nothing in the
connector path caps a response size, and a flow that interpolates one into a
model step sends the whole thing as a prompt. Register a longer `timeoutMs`,
and use them to build a watch list rather than inside a pipeline.

**Where the publish gate actually sits.** For `typefully` it is the arg
allowlist: `create_draft` and `schedule_draft` are the same endpoint, and the
first cannot pass a schedule date because the route does not declare one — so
filing a draft for a human and putting one on the wire are admitted separately.
For `ghost` and `medium` the visibility lives in the request body (`status`,
`publishStatus`), which an allowlist cannot split, so every write there carries
publishing authority and is documented as doing so.

**Two presets ask for something before they will build.** `ghost` ships no base
URL, because the site is yours (`--base-url https://<site>/ghost/api/admin`);
`medium` authenticates only with a legacy integration token, and Medium no longer
issues them — an account without one cannot use that preset at all.

`npm` and `pypi` are public and send no credential. Passing `--token-env` to one
is an error rather than a no-op: an operator who names a token there believes one
is going out.

A preset may also pin constant headers the service requires — `notion` sends
`Notion-Version`, `ghost` sends `Accept-Version`. They are part of the connector,
not a flow's args, and one that would shadow the credential is rejected at
registration.

## Registering one by hand

Anything without a preset is written out in full. `LACREW_CONNECTORS` holds
inline JSON or a path to a JSON file, and the two forms mix in one array:

```json
[
  {
    "id": "github",
    "baseUrl": "https://api.github.com",
    "auth": { "kind": "bearer", "tokenEnv": "GH_TOKEN" },
    "routes": [
      {
        "name": "get_pull_request",
        "method": "GET",
        "path": "/repos/{owner}/{repo}/pulls/{number}",
        "effect": "read"
      },
      {
        "name": "merge_pull_request",
        "method": "PUT",
        "path": "/repos/{owner}/{repo}/pulls/{number}/merge",
        "effect": "write",
        "params": ["merge_method"],
        "policyTarget": "0x…"
      }
    ]
  }
]
```

A flow then calls it like any other tool:

```ts
flow("bot-pr-triage")
  .tool("pr", "github.get_pull_request", {
    owner: "{{input.owner}}",
    repo: "{{input.repo}}",
    number: "{{input.number}}",
  })
```

`{{input.<key>}}` reads a field of a JSON run input, so a route gets its args
without a model being asked to re-extract each one from a blob it already has.

## What a flow cannot do

Flow definitions arrive as untrusted JSON — from the visual builder, from a
marketplace listing. The registry is built on that assumption:

| | |
| --- | --- |
| **Routes are an allowlist, not a URL** | A flow names a route the operator wrote down. It cannot compose a URL, change the method, or reach a host nobody admitted. |
| **Path args cannot escape their segment** | `{placeholder}` values are percent-encoded, so `../../user/repos` stays one segment. |
| **Undeclared args are dropped** | Only names in the route's `params` reach the query string or body. A definition cannot smuggle `admin_override` into a request the operator described. |
| **Credentials never enter the flow** | Auth is read from the environment at call time. A missing credential fails the call rather than sending an unauthenticated one. |
| **`http://` is refused** | Except for loopback, so a local tool server still works in development. |

An invalid connector is rejected at registration, and the orchestrator refuses
to boot with one — a silently dropped connector reads to a flow author as "the
tool does not exist yet".

## Writes ask the policy stack

A route with `effect: "write"` may carry a `policyTarget`: an address standing
for the authority to take that action. Before the call, the registry asks the
policy stack about that address, and anything but `ALLOW` refuses the call —
`ESCALATE` included, because a pending approval is not permission.

This gives an action the same admission mechanism money has. The crew's ability
to merge pull requests is one whitelisted address: admitting it is a governance
proposal, and revoking it turns merging off org-wide in a single action, without
touching GitHub or redeploying anything.

Flows are expected to ask first and route on the answer, so a refusal is a
branch rather than a failed run:

```ts
  .tool("merge-check", "lacrew_check_policy", { target: "{{target.merge-authority}}", value: "0" })
  .branch("may-merge", {
    when: { source: "{{steps.merge-check.json}}", op: "contains", value: "\"ALLOW\"" },
    onTrue: "merge",
    onFalse: "merge-blocked",
  })
```

The registry re-checks regardless, so a flow that skipped the question still
cannot merge. The check is the courtesy; the registry is the control.

## Asking what is actually wired

Connectors are configured from the environment, so an operator surface has no
way to guess whether GitHub is hooked up. `GET /connectors` answers it:

```bash
curl -s localhost:8788/connectors | jq .
```

```json
{
  "connectors": [
    {
      "id": "github",
      "baseUrl": "https://api.github.com",
      "auth": { "kind": "bearer", "envVars": ["GH_TOKEN"], "ready": true },
      "routes": [
        { "name": "get_pull_request", "method": "GET", "effect": "read", "policyTarget": null },
        { "name": "merge_pull_request", "method": "PUT", "effect": "write", "policyTarget": "0x…" }
      ]
    }
  ],
  "available": [{ "id": "…", "title": "…" }]
}
```

`connectors` is what is registered; `available` is the presets that ship and are
not. Keeping them apart is the point — a catalog that merges them tells an
operator a crew can merge pull requests when nothing is wired.

`auth` names the environment variables the connector reads and whether they are
set. Never a value: "is my token there?" is answerable without reading it, and a
status route that reads it is an exfiltration route. A `github-app` connector
also reports whether an installation token is currently held and when it
expires — again, not the token.

## Every call is on the audit trail

Each call emits a `ToolCalled` event: connector, route, method, effect, status,
duration, and whether a policy check gated it. Never the response body — a PR
diff or a draft post has no business in an audit row — and never the credential.

A `write` row is a crew acting on the world, which makes this the trail an
operator reads when asking what their agents actually did.

## Offline

Without a registered connector, `createMockFlowBackend` answers a connector-shaped
tool name with `{ ok: false, note: "no connector registered — nothing was called" }`
so offline runs complete without inventing a response. A misspelled `lacrew_*`
name still throws.

## Blueprints declare what they need

A crew blueprint lists the connectors its flows call, so the operator knows what
to register before standing the crew up:

```bash
lacrew crews show github-experts
# Connectors to register before the crew can work
#   github  (github.get_pull_request, github.merge_pull_request)
#      ships as a preset:  lacrew connectors show github
```

`validateCrewBlueprint` rejects a blueprint whose flows call a route no declared
connector serves.
