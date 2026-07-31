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

## Connector or MCP server?

A connector is HTTP routes you wrote down, and it is the only one of the two
that can bind a write to a `policyTarget` — reach for it when the action is one
the policy stack should answer for.

When the surface already speaks MCP, attach it instead of transcribing it:
[External MCP servers](./external-mcp.md) composes somebody else's server behind
the same `auto` / `ask` / `deny` vocabulary, with every tool blocked until an
operator allows it by name. Both are registered per workspace, both are audited,
and neither can widen what the chain admits.

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

## Writes also run in a mode: auto, ask, deny

A policy target answers "is this crew admitted to do this at all". It cannot
answer the question operators ask constantly, which is "policy allows the merge,
and I still want to see it first". So every write route also has a **mode**, and
the vocabulary is the onchain one turned outward:

| Onchain verdict | Write mode | What happens |
| --- | --- | --- |
| `ALLOW` | `auto` | admitted, and called without asking |
| `ESCALATE` | `ask` | admitted, and a human confirms in-thread before the call |
| `DENY` | `deny` | never called, and the network is never reached |

The parallel is deliberate. An operator who has learned what ESCALATE means for
a spend already knows what `ask` means for a publish.

**A mode only ever narrows.** `auto` admits nothing — a route with a
`policyTarget` is still checked against the stack first, and a `DENY` there
refuses the call whatever the mode says. The most this control can do is require
a confirmation or refuse outright, which is why an operator cannot widen a crew's
reach by editing a dropdown. Reads carry no mode at all: a confirmation that
gates nothing teaches people to click through the ones that matter.

The three refusals are distinct codes, because they send an operator to
different places:

| Code | Cause | Where the fix is |
| --- | --- | --- |
| `connector_mode_denied` | mode is `deny` | the mode rule |
| `connector_denied` | policy stack said DENY / ESCALATE | governance |
| `connector_ask_declined` | a human answered `no` | nowhere — it worked |
| `connector_ask_timeout` | nobody answered in time | the question, still in the thread |

### What `ask` actually does

The run **stops**. It does not block: a person answers in minutes or hours, and
a run that waited would tie a funded crew's work to one process surviving a
redeploy. The step posts a `question` into the principal's thread, the run is
suspended to durable state with status `waiting`, and whichever replica handles
the answer resumes it at the same step.

```
… pr-merge · waiting · 1 steps · run run-abc
  waiting on a human to confirm github.merge_pull_request (ask_9f2c…)
  Answer it:  lacrew connectors asks
```

Only `yes` and `no` count. "sure, go ahead" is a sentence a person means as a
yes and a parser can only guess at, and a wrong guess is a merge nobody
authorised — so free text resolves nothing, the question is re-posted, and the
write stays in the queue.

A confirmation is keyed to the **request**, not to the route: method, rendered
path, and the fields the route forwards are hashed into a fingerprint. Merge a
different pull request and it is a different ask with its own question. One yes
is spent once and never applies again, including across a restart.

An ask that nobody answers expires (default 24 hours,
`LACREW_CONNECTOR_ASK_TTL_MS`) and the step fails closed. Nothing is called.

### The confirmation is a claim, not an approval

Answering `yes` releases a step the policy stack had **already** admitted. It
admits nothing on its own, and a write that also moves money still raises its
intent and still meets the escalation path. The answer is an ordinary
conversation message with an ordinary author, resolved server-side; there is no
route that resolves an ask directly, because one would be a second way to
release a write with no record in the thread.

### Setting a mode

Presets ship `ask` on the routes whose mistakes are public and hard to take
back — merge a pull request, publish a post, send a tweet. Typefully's
`create_draft` does not, because that route cannot publish.

```bash
lacrew connectors modes                                   # rules + what each mode means
lacrew connectors mode github.merge_pull_request ask      # workspace-wide
lacrew connectors mode github.* deny --scope agent:0x…    # one seat, every route
lacrew connectors mode github.merge_pull_request --clear  # back to what it inherits
```

Rules resolve narrowest-first — **agent, then crew, then workspace, then the
route's own default** — and an exact route beats a `<connector>.*` at the same
level. A crew rule names the node it hangs from and applies to every seat below
it, so "this desk never publishes" is one rule rather than one per worker.
Clearing a rule is not the same as setting `auto`: it removes the exception, so
the route goes back to inheriting.

### Working the queue

```bash
lacrew connectors asks                                    # writes waiting on a human
lacrew connectors answer ask_9f2c yes --as human:ops
```

The same questions appear in the Questions rail and on `GET /messages`, because
they are the same messages. Every ask emits `ConnectorAsk` when it is raised and
`ConnectorAskResolved` when it ends — `approved`, `declined`, or `expired`. The
payload carries the fingerprint and never the arguments: a rendered path
routinely names a private repository, and the trail is not the place to publish
one. Changing a mode emits `ConnectorWritePolicyChanged`, because moving a merge
from `ask` to `auto` removes the human from every future merge and that should
be attributable to whoever did it.

One gap worth knowing: an ask-mode write inside a **delegated** flow (an `agent`
step naming another flow) fails the delegating step rather than suspending. The
ask holds the child run's state, and releasing it would leave the parent parked
with nothing to continue it.

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
        {
          "name": "get_pull_request", "method": "GET", "effect": "read",
          "policyTarget": null, "mode": null, "effectiveMode": null
        },
        {
          "name": "merge_pull_request", "method": "PUT", "effect": "write",
          "policyTarget": "0x…", "mode": "ask",
          "effectiveMode": { "mode": "deny", "source": { "kind": "rule", "scope": { "level": "workspace" }, "route": "github.*" } }
        }
      ]
    }
  ],
  "available": [{ "id": "…", "title": "…" }]
}
```

`connectors` is what is registered; `available` is the presets that ship and are
not. Keeping them apart is the point — a catalog that merges them tells an
operator a crew can merge pull requests when nothing is wired.

`mode` is what the route declares; `effectiveMode` is what would actually apply,
and what decided it. Pass `?as=0x…` to resolve it for one seat — without it the
answer is the workspace's, which is the one nobody's flow runs under once a
single override exists.

`auth` names the environment variables the connector reads and whether they are
set. Never a value: "is my token there?" is answerable without reading it, and a
status route that reads it is an exfiltration route. A `github-app` connector
also reports whether an installation token is currently held and when it
expires — again, not the token.

## Every call is on the audit trail

Each call emits a `ToolCalled` event: connector, route, method, effect, status,
duration, whether a policy check gated it, and the mode a write ran in. Never
the response body — a PR diff or a draft post has no business in an audit row —
and never the credential.

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
