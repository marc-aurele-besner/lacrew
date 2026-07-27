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
self-hosted instance such as GitHub Enterprise), `tokenEnv`, `timeoutMs`, and
`id`. A preset expands to a plain connector and is validated identically — it
saves the copying, not the operator's decision.

| Preset | Routes | Credential |
| --- | --- | --- |
| `github` | `get_pull_request`, `list_pull_requests`, `list_pull_request_files`, `get_combined_status`, `list_check_runs` (reads); `merge_pull_request` (write, needs a policy target) | `GH_TOKEN` — fine-grained PAT or App installation token, scoped to the allowlisted repos |

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
