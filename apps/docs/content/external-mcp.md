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

For the same reason, a wildcard rule may only *narrow*:

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

| Mode | What happens |
| --- | --- |
| `auto` | called |
| `ask` | a question goes into the principal's thread; the run parks until someone answers `yes` |
| `deny` | never called, and the server is never reached |

```bash
curl -s -X PUT http://127.0.0.1:8788/mcp/servers/tools \
  -H 'content-type: application/json' \
  -d '{"server":"gh","tool":"create_issue","enabled":true,"effect":"write","mode":"ask"}'
```

A tool nobody has classified counts as a **write** — the unexamined tool is the
one to be careful with. With no ask surface wired, an `ask` write is *refused*
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
orchestrator. Self-host only. The hosted plane admits HTTP MCP first, to
allowlisted hosts, because running arbitrary subprocesses on a shared worker is
a sandboxing problem, not a configuration one.

## The audit trail

| Event | When |
| --- | --- |
| `ExternalMcpCalled` | every call *and every refusal* — server, tool, effect, mode, duration, whether it went out |
| `ExternalMcpDiscovered` | a refresh, with what appeared and what vanished |
| `ExternalMcpToolPolicyChanged` | somebody allowed, disabled, or re-moded a tool |

No arguments, and no results. A tool argument routinely names a customer or a
private repository, and a result is unbounded third-party text.
`LACREW_MCP_AUDIT_ARGS=1` adds argument *keys* — never values — when you are
debugging a flow.

Refusals are recorded for a reason: an attempt on a tool nobody admitted leaves
no other trace, and it is exactly the thing an operator wants to find.

## From the CLI

The same decisions without the JSON:

```bash
lacrew mcp servers                 # every attached server, every tool's state
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

| Variable | Meaning |
| --- | --- |
| `LACREW_MCP_SERVERS` | inline JSON or a path to a JSON file; unset means no server is attached |
| `LACREW_MCP_REFRESH_MINUTES` | discovery cadence in minutes (default `60`, `0` disables the sweep) |
| `LACREW_MCP_AUDIT_ARGS` | `1` records argument keys on the audit trail; values are never recorded |

## Routes

| Route | What it does |
| --- | --- |
| `GET /mcp/servers[?as=]` | attached servers, their tools, and what each resolves to for a seat |
| `POST /mcp/servers/refresh` | re-read tool lists; new tools are recorded blocked |
| `POST /mcp/servers/ping` | reachability check for a setup drawer |
| `PUT /mcp/servers/tools` | allow, disable, re-mode, or clear one tool rule |
| `GET /mcp/tools[?as=]` | first-party tools plus the external ones a seat may call |
| `POST /mcp/call` | call a tool by name, through the same allowlist a flow meets |
