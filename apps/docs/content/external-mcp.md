# External MCP servers

LaCrew serves MCP: the `lacrew_*` tools are how an agent reads the org chart,
checks a policy, and proposes an intent. This is the other direction — attaching
**somebody else's** MCP server so a crew can use the tools an operator already
runs for GitHub, a browser, a database, an internal API.

It is composition, not a second connector system. Connectors stay what they
are: HTTP routes you wrote down, policy-target aware. External MCP is for the
much larger set of surfaces the ecosystem already exposes over MCP, where
writing a preset per SaaS is the wrong amount of work.

The thing that makes attaching safe is simple to state:

> **A server's tool list is not the agent's tool list.**

Everything below follows from that.

## Attach a server

`LACREW_MCP_SERVERS` takes inline JSON or a path to a JSON file:

```json
[
  {
    "id": "gh",
    "title": "GitHub MCP",
    "transport": "http",
    "url": "https://mcp.example.com/rpc",
    "auth": { "kind": "bearer", "tokenEnv": "GH_MCP_TOKEN" },
    "timeoutMs": 20000,
    "maxResponseBytes": 1000000
  }
]
```

A stdio server is a subprocess instead of a URL:

```json
[
  {
    "id": "fs",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/crew-workspace"],
    "env": ["HOME", "MCP_WORKSPACE_TOKEN"]
  }
]
```

`env` is a list of variable **names**, and the child is given those and nothing
else — not the orchestrator's environment, which holds the session sealing key
and every connector credential. `auth` works the same way: the config names the
variable, the value is read at call time, and no route ever returns it.

Unset, no server is attached. That is the normal state, not an error.

### …or attach one while it is running

`LACREW_MCP_SERVERS` is a boot config: the orchestrator re-reads it at every
start, and it is the right home for a server an operator owns. It is not much
use to somebody who cannot restart the process — a hosted workspace, or anyone
who would rather not bounce a runtime to add a tool source. `POST
/mcp/servers/attach` takes the same config object and applies it now:

```bash
lacrew mcp attach gh \
  --endpoint https://mcp.example.com/rpc \
  --title 'GitHub MCP' \
  --token-env GH_MCP_TOKEN
# Attached gh (http) → https://mcp.example.com/rpc. No restart needed.
#   2 tool(s) found, all blocked: create_issue, search_issues
#   Allow one by name: lacrew mcp allow gh.<tool>
```

Attaching runs discovery immediately and every tool it finds is recorded
**blocked**, exactly as a boot-configured server's are. "Attached" and
"callable" stay two decisions.

`--token-env` names an environment variable; it is never the token. The CLI has
no way to send a credential and the route has no field to carry one — the same
property that makes a config safe to store, serve and log.

A runtime attach is persisted (`orchestrator_external_mcp_servers`) and restored
at boot, so it survives a restart. With no database it lives as long as the
process, which is the honest behaviour of a runtime with no persistence.
`lacrew mcp detach <id>` forgets one; a **boot-configured** server is refused
(409) because env is its source of truth and a removal the next restart undoes
would be a lie. Detaching keeps the tool rules, so re-attaching under the same
id cannot silently re-admit a tool somebody denied.

### Bring your own token

Naming an environment variable works because whoever writes the config also owns
the process's environment. On a shared worker those are different people: a
workspace cannot set an env var on a runtime other workspaces are using, and an
operator provisioning one credential per tenant by hand does not scale.

So a credential can live in the orchestrator's own **sealed store** instead, and
the config still names it rather than carrying it:

```bash
# The value comes from stdin or --from-env, never an argument: an argument
# lands in shell history and in every `ps` on the machine.
printf %s "$GH_TOKEN" | lacrew mcp secret set gh
lacrew mcp attach gh --endpoint https://mcp.example.com/rpc --secret-ref gh
```

```json
{ "kind": "secret", "secretRef": "gh" }
```

What that buys, and what it costs:

- **Sealed at rest**, AES-256-GCM under `LACREW_SESSION_KEY` — the same envelope
  and key that seals session keys, because the trust boundary is identical and a
  second key is a second thing to lose. With **no sealing key the write is
  refused** (503), never stored in cleartext.
- **Never readable back.** No route returns a value. `GET /mcp/secrets` gives the
  ref and the last four characters, which tells one token from another and is
  useless to anyone else. The audit row carries the same.
- **Owner-scoped, with no fallback.** A secret belongs to the scope that wrote
  it, and a server resolves only secrets under its *own* owner. Two workspaces
  may both call their token `gh`; neither can reach the other's, and a workspace
  cannot resolve the operator's by guessing its name — that would be the same
  escalation `LACREW_MCP_ALLOW_ENV` exists to prevent, arriving through a second
  door. An operator sharing one credential does it with that variable, where the
  sharing is written down.
- **It asks nothing of the environment**, which is what lets a secret-backed
  server attach on a hosted worker that offers no env var at all.
- The cost, stated plainly: the value crosses the wire once, on the write. That
  is inherent to bringing your own token, and it is the only moment it exists
  outside the envelope.

A missing credential fails the call (`mcp_missing_credential`) rather than
sending an unauthenticated request — a far side answering an unauthenticated
request with an empty list looks exactly like a real answer.

## Nothing is callable until you say so

Attaching a server admits nothing. Discovery reads the tool list and **records
what it found as blocked**:

```bash
curl -s -X POST http://127.0.0.1:8788/mcp/servers/refresh | jq .
# { "results": [ { "server": "gh", "ok": true,
#   "added": ["create_issue", "search_issues"], "removed": [], "unchanged": [] } ] }

curl -s http://127.0.0.1:8788/mcp/servers | jq '.servers[0].blockedCount'
# 2
```

Allow one, by name:

```bash
curl -s -X PUT http://127.0.0.1:8788/mcp/servers/tools \
  -H 'content-type: application/json' \
  -d '{"server":"gh","tool":"search_issues","enabled":true,"effect":"read"}'
```

A flow calls it as `mcp__gh__search_issues`. The `mcp__<server>__<tool>`
namespace is why an attached server can neither shadow a `lacrew_*` tool nor a
`<connector>.<route>`, whatever it decides to name its tools.

Anything not allowed is refused before the network:

```
tool_not_allowlisted:gh.create_issue      # 403 from POST /mcp/call
```

## A tool that appears later is blocked too

This is the property worth the whole design. Servers change. A release adds a
tool; so does a compromised package, and from the orchestrator the two look
identical. A refresh that added tools to your crew's reach would make every
upstream publish an authority change nobody approved.

So a refresh **records** new tools and admits none of them:

```
[@lacrew/orchestrator] external MCP: 1 new tool(s) blocked until allowed: delete_repository
```

The sweep runs hourly by default (`LACREW_MCP_REFRESH_MINUTES`, `0` disables
it), and each pass emits an `ExternalMcpDiscovered` audit row naming what
appeared. Nothing about that row changes what a crew may call.

For the same reason, a wildcard rule may only _narrow_:

```bash
# Kill switch for a whole server, for one seat — allowed.
-d '{"scope":{"level":"agent","ref":"0xWORKER"},"server":"gh","tool":"*","enabled":false}'

# Admit everything the server publishes — refused, and always will be.
-d '{"server":"gh","tool":"*","enabled":true}'
# 400  rule "gh.*" cannot enable: a wildcard may only narrow
```

## Writes run in a mode

Every tool is classified `read` or `write`, once, at workspace scope. A write
runs in a mode — the same `auto` / `ask` / `deny` vocabulary as
[connector writes](./connectors.md), and for the same reason: an operator who
knows what ESCALATE means for a spend already knows what `ask` means for an
issue that gets filed under the company's name.

| Mode   | What happens                                                                           |
| ------ | -------------------------------------------------------------------------------------- |
| `auto` | called                                                                                 |
| `ask`  | a question goes into the principal's thread; the run parks until someone answers `yes` |
| `deny` | never called, and the server is never reached                                          |

```bash
curl -s -X PUT http://127.0.0.1:8788/mcp/servers/tools \
  -H 'content-type: application/json' \
  -d '{"server":"gh","tool":"create_issue","enabled":true,"effect":"write","mode":"ask"}'
```

A tool nobody has classified counts as a **write** — the unexamined tool is the
one to be careful with. With no ask surface wired, an `ask` write is _refused_
(`mcp_mode_denied:…:ask_unavailable`) rather than called: "confirm this first"
must never degrade into "go ahead" because of a wiring gap.

`effect` may only be set at workspace scope. A crew or seat rule may disable a
tool or tighten its mode, but calling a write a read at one seat would be a
per-seat route around ask/deny.

## Scoping

Rules resolve narrowest-first — agent, then the nearest crew in the reporting
line, then the workspace — with an exact tool name beating a `*` at the same
level. That is the ordering that lets you write one broad rule and carve a
single seat out of it.

```bash
# Everyone may search…
-d '{"server":"gh","tool":"search_issues","enabled":true,"effect":"read"}'
# …except this desk.
-d '{"scope":{"level":"crew","ref":"0xDESK"},"server":"gh","tool":"search_issues","enabled":false}'
```

`GET /mcp/servers?as=0xSEAT` and `GET /mcp/tools?as=0xSEAT` answer for one seat,
which is the only answer that matches what its flows will actually run under.

Omitting `enabled` on a `PUT` **clears** the rule at that scope, which is not
the same as disabling it: clearing drops an exception so the tool inherits
again, while `enabled: false` pins the refusal there.

## What an external server cannot do

- **It cannot widen authority.** External tools are dispatched through the
  registry, never through the session-signing path. No MCP server can change a
  PolicyModule, mint or extend a session key, or reach the treasury. A spend is
  still an intent, still meets the policy stack, and still escalates.
- **It cannot shadow a first-party tool.** The `mcp__` namespace is reserved and
  parsed at the server boundary.
- **It cannot see your environment.** Stdio children get only the variables you
  named; HTTP servers get only the credential the config points at.
- **It cannot hand you an unbounded response.** Every call is bounded by
  `timeoutMs` and `maxResponseBytes`, enforced while the body is read.

## Threat model

Attaching a server is trusting third-party code with the reach you allow it.
Two failure modes are worth naming plainly.

**A malicious or compromised server.** It can lie about its tool list, return
whatever it likes, and time its behaviour to change after you looked. The
allowlist is what bounds the damage: it may only act through tools you allowed
by name, writes among those can be held behind `ask` or refused with `deny`, and
a tool that appears later starts blocked. On self-host, put egress controls
around the orchestrator — an attached HTTP server is a host your worker now
talks to, and network policy is the layer that can say which hosts those are.

**Prompt injection through tool results.** Tool output is attacker-reachable
text: an issue body, a web page, a row somebody else wrote. Results come back
flagged `untrusted: true` so a model step reads them as data rather than as
instructions, but the flag is a mitigation and not a fix. The real defence is
that the crew's authority is bounded elsewhere — a model talked into merging
still meets the policy stack, the write mode, and the human on the other end of
an `ask`.

**Stdio is code execution.** A stdio server runs as a child of your
orchestrator, with your worker's filesystem and network. That is a reasonable
trade on a machine you own and not one to make on a worker running other
people's crews — so a hosted orchestrator refuses it (see below).

**SSRF.** An orchestrator sits where a cloud's metadata service, your database,
and every other workspace's internal endpoint are reachable. Anyone who can name
a URL therefore has a request-forgery primitive, and on a hosted plane the
person naming the URL is a tenant. This is what the egress policy is for.

## Self-host vs hosted: where a server may live

`LACREW_MCP_HOSTED=1` says this process runs more than one workspace's crews. It
flips every default to deny:

|                                         | self-host (default)                         | `LACREW_MCP_HOSTED=1`                            |
| --------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| stdio servers                           | allowed                                     | **refused** unless `LACREW_MCP_ALLOW_STDIO=1`    |
| http hosts                              | anywhere, or the allowlist if you wrote one | **only** `LACREW_MCP_ALLOW_HOSTS`                |
| loopback / plain http                   | allowed                                     | **refused** unless `LACREW_MCP_ALLOW_LOOPBACK=1` |
| credential env vars on a runtime attach | any name                                    | **only** `LACREW_MCP_ALLOW_ENV` (empty = none)   |

Three rules hold in both modes, because they are not about tenancy:

- **https only**, except loopback, where plain http is what local development
  actually looks like.
- **No private address literals.** `10.0.0.5`, `192.168.x`, `169.254.169.254`,
  `fd00::/7`, `fe80::/10` and friends are refused even if somebody allowlists
  them by hand. They are inside the perimeter, not a third party.
- **No credential in the URL.** `https://user:pass@…` is refused: a credential
  in a URL is carried rather than named, and lands in every log line that prints
  an endpoint.

`LACREW_MCP_ALLOW_HOSTS` takes exact names or `*.example.com` (any depth of
subdomain), each optionally `:port`-pinned. A hosted worker with **no** allowlist
reaches nothing at all, which is the correct state for a pool whose operator has
not decided yet — and it says so rather than failing at the first call.

Where DNS is concerned the allowlist is the boundary, not a lookup: on a hosted
worker only the hosts the operator wrote down are reachable in the first place.
Behind it, a hostname is resolved before connecting and a private answer is
refused — which catches an allowlisted name pointed at the metadata service.
That check narrows the window rather than closing it, since DNS can change
between the check and the socket.

The policy is re-checked **before every call**, not trusted from the moment a
server was attached: a config stored while the worker was single-tenant must not
keep its reach after hosted mode is turned on. For the same reason, a stored
server the current policy refuses does not come back at boot, and the refusal is
on the trail rather than silent.

**Who sees which server.** A server attached at runtime may carry an `owner`
scope. One that does is invisible to every seat outside it: another workspace
cannot list it, refresh it, call it, or detach it, and a call names it
`unknown_external_mcp_tool` rather than admitting it exists. Boot-configured
servers have no owner and are the operator's own, visible to everyone in the
process.

## The audit trail

| Event                          | When                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `ExternalMcpCalled`            | every call _and every refusal_ — server, tool, effect, mode, duration, whether it went out |
| `ExternalMcpDiscovered`        | a refresh, with what appeared and what vanished                                            |
| `ExternalMcpToolPolicyChanged` | somebody allowed, disabled, or re-moded a tool                                             |
| `ExternalMcpServerChanged`     | a server was attached, replaced, or detached at runtime                                    |
| `ExternalMcpSecretChanged`     | a sealed credential was stored or cleared — ref and last four characters, never the value  |

No arguments, and no results. A tool argument routinely names a customer or a
private repository, and a result is unbounded third-party text.
`LACREW_MCP_AUDIT_ARGS=1` adds argument _keys_ — never values — when you are
debugging a flow.

Refusals are recorded for a reason: an attempt on a tool nobody admitted leaves
no other trace, and it is exactly the thing an operator wants to find.

## From the CLI

The same decisions without the JSON:

```bash
lacrew mcp servers                 # every attached server, every tool's state
lacrew mcp attach gh --endpoint https://mcp.example.com/rpc --token-env GH_MCP_TOKEN
lacrew mcp detach gh               # forget one attached at runtime
lacrew mcp secret list             # stored credentials — refs and last four characters
printf %s "$GH_TOKEN" | lacrew mcp secret set gh   # sealed; no route returns it
lacrew mcp secret rm gh
lacrew mcp refresh                 # re-read tool lists; new tools land blocked
lacrew mcp ping gh                 # reachable? how many tools does it publish?

lacrew mcp allow gh.search_issues --effect read
lacrew mcp allow gh.create_issue  --effect write --mode ask
lacrew mcp deny  gh.'*' --scope agent:0xWORKER    # kill switch for one seat
lacrew mcp clear gh.search_issues --scope agent:0xWORKER   # inherit again
```

`lacrew mcp servers --as 0xSEAT` resolves the listing for one seat, which is the
answer that matches what its flows run under.

## Environment

| Variable                     | Meaning                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `LACREW_MCP_SERVERS`         | inline JSON or a path to a JSON file; unset means no server is attached                                  |
| `LACREW_MCP_REFRESH_MINUTES` | discovery cadence in minutes (default `60`, `0` disables the sweep)                                      |
| `LACREW_MCP_AUDIT_ARGS`      | `1` records argument keys on the audit trail; values are never recorded                                  |
| `LACREW_MCP_HOSTED`          | `1` — this process runs more than one workspace; every default becomes deny                              |
| `LACREW_MCP_ALLOW_HOSTS`     | comma-separated hosts an http server may live on (`example.com`, `*.example.com`, either `:port`-pinned) |
| `LACREW_MCP_ALLOW_STDIO`     | `1` re-allows subprocess servers under `LACREW_MCP_HOSTED`; `0` refuses them on a self-host              |
| `LACREW_MCP_ALLOW_LOOPBACK`  | `1` re-allows loopback endpoints under `LACREW_MCP_HOSTED`                                               |
| `LACREW_MCP_ALLOW_ENV`       | env var names a **runtime** attach may read (`NAME` or `PREFIX_*`); empty means none                     |

## Routes

| Route                       | What it does                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `GET /mcp/servers[?as=]`    | attached servers, their tools, what each resolves to for a seat, and the egress policy |
| `POST /mcp/servers/attach`  | attach or replace a server now; 403 names the egress rule that refused                 |
| `POST /mcp/servers/detach`  | forget a runtime-attached server; 409 on a boot-configured one                         |
| `POST /mcp/servers/refresh` | re-read tool lists; new tools are recorded blocked                                     |
| `POST /mcp/servers/ping`    | reachability check for a setup drawer                                                  |
| `PUT /mcp/servers/tools`    | allow, disable, re-mode, or clear one tool rule                                        |
| `GET /mcp/tools[?as=]`      | first-party tools plus the external ones a seat may call                               |
| `POST /mcp/call`            | call a tool by name, through the same allowlist a flow meets                           |
