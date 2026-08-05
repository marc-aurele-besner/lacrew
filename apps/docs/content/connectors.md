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
`policyTarget` — that address only exists once the crew is stood up. Nor will it
guess where a push may land. Bind what applies and emit the config:

```bash
lacrew connectors config github --policy-target merge_pull_request=0xMERGE_AUTHORITY
```

Registering only what a crew needs is the point: `--omit` leaves a route out
entirely, and a read-only GitHub connector needs no address at all. Where
several routes are one authority, they bind under one name — `connectors show`
prints which, and says what it admits.

## Credentials: prefer an App to a personal token

A preset can declare more than one way to authenticate, listed best-posture
first. The first is what you get if you do not choose.

For GitHub that is a **GitHub App installation**, and the difference is not
stylistic:

|             | Personal access token               | App installation                             |
| ----------- | ----------------------------------- | -------------------------------------------- |
| Reach       | whatever its owner can reach        | only the repos the App was installed on      |
| Attribution | every crew action is a person's     | the App's own identity in GitHub's audit log |
| Revocation  | takes away that person's access too | uninstall, nobody else affected              |

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

| Preset             | What a crew uses it for                                          | Writes (need an address)                                       | Credential modes                              |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| `github`           | Pull requests, files, CI state, file contents, git refs and trees | `merge_pull_request`, `create_issue_comment`, and the push (`update_file`, `create_tree`, `create_commit`, `update_ref`, which bind one address between them) | `github-app` (default) · `token` → `GH_TOKEN` |
| `gitlab`           | Merge requests, diffs, pipelines — gitlab.com or self-hosted     | `merge_merge_request`                                          | `token` → `GITLAB_TOKEN` (`PRIVATE-TOKEN`)    |
| `npm`              | Published versions, dist-tags, deprecations                      | —                                                              | `none`                                        |
| `pypi`             | Release history, requires-python, yanked releases                | —                                                              | `none`                                        |
| `twitter`          | Search, timelines, one post                                      | `create_tweet`                                                 | `token` → `TWITTER_BEARER_TOKEN`              |
| `typefully`        | Draft queue and scheduling                                       | `schedule_draft` (`create_draft` files a draft and needs none) | `token` → `TYPEFULLY_API_KEY`                 |
| `ghost`            | The site's posts; files new ones                                 | `create_post`, `update_post`                                   | `token` → `GHOST_ADMIN_TOKEN`                 |
| `medium`           | Alternate publish surface                                        | `create_post`                                                  | `token` → `MEDIUM_INTEGRATION_TOKEN`          |
| `notion`           | Brand voice docs and past posts, read-only                       | —                                                              | `token` → `NOTION_TOKEN`                      |
| `uniswap`          | Pool state and liquidity via the v3 subgraph                     | —                                                              | `token` → `GRAPH_API_KEY`                     |
| `tenderly`         | Dry-run a call before proposing it                               | —                                                              | `token` → `TENDERLY_ACCESS_KEY`               |
| `coingecko`        | Prices and market context                                        | —                                                              | `token` → `COINGECKO_API_KEY`                 |
| `defillama`        | Protocol and chain TVL — money leaving before a headline says so | —                                                              | `none`                                        |
| `defillama-yields` | Pool-level APY and its history                                   | —                                                              | `none`                                        |
| `aave`             | Aave v3 reserve data: supply and borrow rates, liquidity, caps   | —                                                              | `none`                                        |

GitHub is the only one that offers an App today, and it is the only one whose
service supports the shape. Where a service has something closer to it than a
personal token — GitLab's project access tokens, Notion's integration secrets,
scoped to what is shared with them rather than to a person — the preset's note
says so, so the choice is on screen when you make it.

Five things worth reading off that table:

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
megabytes and `defillama-yields.list_pools` around eleven. Both carry a raised
`maxResponseBytes` so the default 1 MB ceiling does not refuse them outright —
see [Responses have a size limit](#responses-have-a-size-limit). Register a
longer `timeoutMs`, and use them to build a watch list rather than inside a
pipeline: the limit bounds what a mistake costs, it does not make one a good
idea.

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

**The push is a set of routes, not a shell.** The `github-experts` fixer gets a
patch onto a bot's PR branch through git's own object API — tree, commit, ref —
so a fix touching several files is one commit rather than several. These are the
only write paths a crew has to a repository's contents — see
[What the fixer can and cannot do](#what-the-fixer-can-and-cannot-do).

A preset may also pin constant headers the service requires — `notion` sends
`Notion-Version`, `ghost` sends `Accept-Version`. A single route can pin one of
its own: `github.get_file_raw` sends `Accept: application/vnd.github.raw` so the
file comes back as text rather than base64, while `github.get_file` reads the
same endpoint as JSON for the blob sha. Headers are part of the connector, not a
flow's args, and one that would shadow the credential is rejected at
registration.

## What the fixer can and cannot do

The `github-experts` charter says the fixer "pushes to the bot's PR branch".
Git is not one REST call, and the answer is not a shell: an orchestrator that
could run `git` for an agent would be a second execution path with none of the
enforcement the first one has. What ships instead is a small set of gated routes
over git's own object model, registered with the branches they may land on:

```bash
lacrew connectors config github \
  --policy-target push_authority=0x… \
  --branch 'dependabot/**' --branch 'renovate/**'
```

**It can:** land a fix of up to twenty files as **one commit** on an allowlisted
branch, having asked `lacrew_check_policy` about the crew's `push-authority`
address and been answered ALLOW. That is git's own object API, in four calls:

```
get_ref     → where the branch points
get_commit  → the tree that commit carries
create_tree → a new tree: base_tree plus the files being changed
create_commit → one commit, one parent — the head that was read
update_ref  → the branch moves. This is the push, and this is the one that asks.
```

One commit means one CI run and one diff for a reviewer, which is the whole
reason not to write files one at a time. Only `update_ref` ships in `ask` mode:
a tree and a commit nothing points at are invisible and get garbage-collected,
so confirming them would gate nothing — and three confirmations per push is how
an operator learns to approve the one that matters without reading it.

All four bind **one** address (`--policy-target push_authority=0x…`), because
it is one decision. `update_file` is also registered for the single-file case:
one call, no sha juggling, same authority and same allowlist.

**It cannot:**

|                                     |                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Force-push or rewrite history**   | There is no field to do it with. `update_ref` takes one argument, the commit — a flow cannot pass `force`, and an undeclared arg is dropped, not sent. Without it GitHub refuses anything that is not a fast-forward, so a branch that moved underneath loses the fix rather than clobbering it. |
| **Write a merge or an orphan commit** | `parents` is one value that goes out as a list of one. Two parents is a merge and none is an orphan; neither is expressible.                                          |
| **Add a symlink or a submodule**    | A tree entry's `mode` and `type` are *fixed* at registration, not allowlisted — `100644` and `blob`. The values that mean symlink (`120000`) and submodule pointer (`160000`) are not values a call can carry. A `sha` field is dropped, so an entry cannot point at a blob nobody wrote. |
| **Push to a branch nobody admitted** | The `branch` arg is pinned to the globs you registered, and it is *required*: GitHub commits to the default branch when a write omits it, so a missing branch is a refused call rather than a commit on `main`. |
| **Escape the repo it named**        | `path` is encoded a segment at a time, and `.`, `..`, and empty segments are refused — inside a tree entry as well as in a URL. So is a branch name containing a `..` component, ahead of the allowlist. |
| **Touch the workflow files**        | `.github/workflows/` is refused as a path prefix by default, on every route that writes a path. `--deny-path` replaces the list; `--deny-path ''` keeps only branch protection and CODEOWNERS. |
| **Delete anything**                 | The DELETE routes on those endpoints are not registered, and no preset ships them.                                                                                    |
| **Upload something enormous**       | A file is capped at 256 KB, a tree at 20 files and 512 KB, and the whole request body at 1 MB. All of them refuse rather than truncate.                                |
| **Push without being admitted**     | `push-authority` is an ordinary whitelist entry. Revoking that one address stops every push the crew can make, org-wide, without touching GitHub.                      |

What it can still get wrong, and what bounds it: an entry naming a file the run
never read replaces that file in full. Nothing structural prevents that — the
bound is the blast radius rather than the model's discipline, which is why the
branch allowlist, the twenty-file cap, the workflow refusal, and a human on the
merge all exist. The `github-experts` blueprint states this as a guardrail with
its residual risk rather than implying the policy stack covers it.

Two addresses stay separate from it on purpose. A crew that may push is not
thereby allowed to merge its own work, and revoking the push must not also
silence the note explaining why a PR is stuck — so `push-authority`,
`merge-authority`, and `comment-authority` are three whitelist entries and three
governance decisions.

What remains outside LaCrew's reach is the same as before: branch protection,
CODEOWNERS, and the scope of the App installation are GitHub's to enforce. The
org chart bounds money and authority, not repository access.

## Constraining what an argument may say

The param allowlist answers *which* fields a flow may set. `argRules` answers
*what they may say*, per route:

```json
{
  "name": "update_file",
  "method": "PUT",
  "path": "/repos/{owner}/{repo}/contents/{path}",
  "effect": "write",
  "params": ["message", "content", "sha", "branch"],
  "argRules": {
    "path": { "multiSegment": true },
    "branch": { "required": true, "pattern": "dependabot/.*" },
    "content": { "encode": "base64", "maxBytes": 262144 }
  }
}
```

| Field          | What it does                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `required`     | The call fails without the argument. Body args are optional by default, which is occasionally dangerous.                |
| `pattern`      | A regex the value must match **whole** — it is anchored for you, so a prefix cannot slip past `dependabot/.+`.          |
| `oneOf`        | The complete set of accepted values.                                                                                    |
| `maxBytes`     | A ceiling on the value as the flow supplied it, checked before any encoding.                                            |
| `multiSegment` | The value is a `/`-separated path: `.`, `..`, and empty segments are refused. On a path arg it also encodes per segment so the slashes survive. |
| `encode`       | Body args only: send the value base64-encoded, so a model can emit plain text for an endpoint that takes base64.        |
| `fixed`        | The value is set at registration and replaces whatever the caller passed. Removes a choice rather than narrowing one.   |
| `json`         | Body args only: parse the value as JSON first, so a route whose body takes a list can be called from a flow at all. A fenced code block is unwrapped; anything else that is not JSON fails the call. |
| `items`        | With `json`: each entry is an object **rebuilt** from these rules. Undeclared keys are dropped, exactly as an undeclared arg is. |
| `maxItems`     | With `items`: how many entries the list may carry.                                                                      |
| `wrap`         | Send the value as a single-element array — when "exactly one" is the property worth having.                            |

A refused value fails the step with `connector_arg_refused:<tool>:<arg>` (or
`connector_arg_too_large:<tool>:<arg>:<limit>`) **before the request is built**,
and the error never echoes the value. Rules that constrain nothing are rejected
at registration: an `argRules` entry naming an argument the route does not take
is a typo, not a silent no-op.

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
flow("bot-pr-triage").tool("pr", "github.get_pull_request", {
  owner: "{{input.owner}}",
  repo: "{{input.repo}}",
  number: "{{input.number}}",
});
```

`{{input.<key>}}` reads a field of a JSON run input, and
`{{steps.<id>.json.<path>}}` reads into an earlier step's result, so a route
gets its args without a model being asked to re-extract each one from a blob it
already has — the push names the `sha` the read returned rather than a hash a
completion retyped.

## What a flow cannot do

Flow definitions arrive as untrusted JSON — from the visual builder, from a
marketplace listing. The registry is built on that assumption:

|                                           |                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Routes are an allowlist, not a URL**    | A flow names a route the operator wrote down. It cannot compose a URL, change the method, or reach a host nobody admitted.                             |
| **Path args cannot escape their segment** | `{placeholder}` values are percent-encoded, so `../../user/repos` stays one segment. A `multiSegment` arg keeps its slashes but still refuses `.`, `..`, and empties. |
| **Undeclared args are dropped**           | Only names in the route's `params` reach the query string or body. A definition cannot smuggle `admin_override` into a request the operator described. |
| **Credentials never enter the flow**      | Auth is read from the environment at call time. A missing credential fails the call rather than sending an unauthenticated one.                        |
| **`http://` is refused**                  | Except for loopback, so a local tool server still works in development.                                                                                |
| **Argument values can be pinned**         | A route's `argRules` hold a value to a pattern, a set, or a size before the request is built. See [Constraining what an argument may say](#constraining-what-an-argument-may-say). |
| **Responses have a ceiling**              | A body over the route's limit is refused, not truncated. See [Responses have a size limit](#responses-have-a-size-limit).                              |
| **Requests have one too**                 | A body over 1 MB is refused with `connector_request_too_large`. What a crew sends is bounded by the registration, not by what a model happened to emit. |

An invalid connector is rejected at registration, and the orchestrator refuses
to boot with one — a silently dropped connector reads to a flow author as "the
tool does not exist yet".

## Responses have a size limit

A connector's response is stringified into `{{steps.<id>.json}}` and handed to
whatever reads it next — usually a model prompt. Without a ceiling, one call to
a bulk listing route is an eleven-megabyte prompt, billed and truncated
somewhere downstream where the cause is invisible.

Every route has a limit. The default is **1 MB**, and a body over it is refused:

```
connector_response_too_large:defillama-yields.list_pools:1048576
```

The step fails with that code. It does **not** return a truncated body — a
half-object is invalid JSON, so it would reach a model as a string that looks
like data and reasons like noise, and nothing downstream could tell that from a
real answer. A refusal is something an operator can act on; a truncation is a
wrong answer nobody sees.

The refusal is on the audit trail as a `ToolCalled` row with `ok: false` and
`refused: "response_too_large"`, carrying the limit that applied. The response
body is not on it — the reason for refusing a body is not a reason to record it.

Where the size is a property of the endpoint rather than the deployment, the
route says so. The bulk DefiLlama routes ship with their own raised ceilings,
because reading every pool once to build a watch list is what they are for:

| Route                         | Limit |
| ----------------------------- | ----- |
| `defillama.list_protocols`    | 16 MB |
| `defillama.get_protocol`      | 64 MB |
| `defillama-yields.list_pools` | 16 MB |

`lacrew connectors show <id>` prints the default and any route that raises it.

Set your own at either level — a route's limit wins over its connector's, which
wins over the default:

```jsonc
{
  "id": "reports",
  "baseUrl": "https://reports.example",
  "auth": { "kind": "bearer", "tokenEnv": "REPORTS_TOKEN" },
  "maxResponseBytes": 262144, // everything here, unless a route says otherwise
  "routes": [
    { "name": "get_summary", "method": "GET", "path": "/summary/{id}", "effect": "read" },
    {
      "name": "export_all",
      "method": "GET",
      "path": "/export",
      "effect": "read",
      "maxResponseBytes": 33554432, // the bulk one, raised deliberately
    },
  ],
}
```

Raising a limit is not the only answer, and usually not the right one. A route
that returns megabytes is a route whose result should be filtered before a model
ever sees it — call the narrow endpoint, or pass the parameters that narrow the
bulk one.

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

| Onchain verdict | Write mode | What happens                                             |
| --------------- | ---------- | -------------------------------------------------------- |
| `ALLOW`         | `auto`     | admitted, and called without asking                      |
| `ESCALATE`      | `ask`      | admitted, and a human confirms in-thread before the call |
| `DENY`          | `deny`     | never called, and the network is never reached           |

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

| Code                     | Cause                             | Where the fix is                  |
| ------------------------ | --------------------------------- | --------------------------------- |
| `connector_mode_denied`  | mode is `deny`                    | the mode rule                     |
| `connector_denied`       | policy stack said DENY / ESCALATE | governance                        |
| `connector_ask_declined` | a human answered `no`             | nowhere — it worked               |
| `connector_ask_timeout`  | nobody answered in time           | the question, still in the thread |

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
          "name": "get_pull_request",
          "method": "GET",
          "effect": "read",
          "policyTarget": null,
          "mode": null,
          "effectiveMode": null
        },
        {
          "name": "merge_pull_request",
          "method": "PUT",
          "effect": "write",
          "policyTarget": "0x…",
          "mode": "ask",
          "effectiveMode": {
            "mode": "deny",
            "source": { "kind": "rule", "scope": { "level": "workspace" }, "route": "github.*" }
          }
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
#   github  (github.get_pull_request, github.list_pull_request_files, github.get_file_raw,
#            github.get_ref, github.get_commit, github.create_issue_comment,
#            github.create_tree, github.create_commit, github.update_ref,
#            github.merge_pull_request)
#      ships as a preset:  lacrew connectors show github
```

`validateCrewBlueprint` rejects a blueprint whose flows call a route no declared
connector serves.
