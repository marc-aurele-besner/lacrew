# Skill packs

A crew's directive has three parts: guidelines (the prose an `AGENTS.md` would
carry), resources (what the seat looks after), and **skills** — named procedures,
each with a trigger saying when it applies.

Guidelines and resources are yours to write. Skills are the part somebody else
can have written: how a bot PR gets triaged, what to read before proposing a
rotation, what a refusal is supposed to look like. A **skill pack** is that
know-how as a versioned file you can review, install onto a seat, update in
place, and take back off.

## A pack is not authority

Installing a pack changes no cap, no whitelist, no session scope, and no
governance rule. It is instruction, and instruction is the layer with no
enforcement behind it — which is exactly why a pack must not be able to imply
capability it has not got.

That is what `requires` is for. A pack names the flows, connector routes and MCP
tools its procedures call, and an install is **refused, never trimmed** when this
deployment does not have one of them. Installing the skills that happen to fit
would leave you a directive that reads complete and an agent holding a procedure
for a tool that is not there.

A pack body is also untrusted text once it comes from anywhere but you: it lands
in a system prompt, so treat an installed third-party pack with the care you
would give a message in the thread.

## The format

JSON. A pack travels the same paths a flow definition does — an HTTP body, a
file, a marketplace payload — and those are already JSON.

```json
{
  "id": "github-pr-triage",
  "version": "1.0.0",
  "name": "GitHub PR triage",
  "summary": "How the crew works a dependency-bot pull request.",
  "scope": "agent",
  "requires": {
    "flows": ["bot-pr-triage", "dep-fix-loop"],
    "connectors": ["github.get_pull_request", "github.merge_pull_request"],
    "mcpTools": ["lacrew_check_policy"]
  },
  "skills": [
    {
      "id": "triage-a-bot-pr",
      "name": "Triage a dependency-bot PR",
      "trigger": "A pull request from a dependency bot is open and nothing has classified it yet.",
      "body": "Run the `bot-pr-triage` flow with owner, repo and number…"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase, stable. Two installs of the same id replace each other. |
| `version` | Any string. Changing it is what makes an install an update. |
| `scope` | `agent`, `crew`, or `either`. A `crew` pack installs onto a `crew:<id>` layer; an `agent` pack onto any other. |
| `skills[].id` | Stable **within the pack**. An update replaces the skill with the same id in place. |
| `skills[].trigger` | Mandatory. A skill with no trigger is one the model applies to everything. |
| `requires.connectors` | A connector id (`github`) or one route (`github.merge_pull_request`). Prefer the route: a connector registered with reads only is a real setup, and a merge procedure installed against it fails where it matters. |

Bounds: 20 skills per pack, 400 characters of trigger, 4,000 of body — and the
whole directive still has to render inside its own ceiling (8,000 characters),
which is checked at install.

## Installed skills carry provenance

An installed skill stores `source: {pack, version, skill}` alongside the text.
Nothing renders it — it is provenance, not instruction — and it buys two things:

- **Uninstall is exact.** Removing a pack removes what that pack put there. A
  skill you wrote by hand has no `source`, and nothing matches on name, so your
  own work cannot be taken with it.
- **Update replaces in place.** A new version of a pack replaces its own skills
  in the slots they already occupied, leaving the ones around them alone.

## From the CLI

```bash
lacrew skills list                 # packs that ship
lacrew skills show github-pr-triage

# against a running orchestrator (ORCH_URL / --url, token via ORCH_TOKEN)
lacrew skills list --url http://127.0.0.1:8788   # adds what this deployment is missing
lacrew skills install github-pr-triage --agent 0xSEAT
lacrew skills install --file ./my-pack.json --agent 0xSEAT
lacrew skills installed --agent 0xSEAT
lacrew skills remove github-pr-triage --agent 0xSEAT
lacrew skills export --agent 0xSEAT --id my-pack > my-pack.json
```

`export` lifts a seat's skills back out as a pack — hand-written ones included,
since those are the ones a restore would otherwise lose. A hand-written skill
with no trigger is exported with the gap named in the field rather than dropped.

## Over HTTP

| Route | Does |
| --- | --- |
| `GET /skills/packs` | The packs that ship, each with what this deployment is missing and whether it is installable |
| `GET /agents/skills?agent=0x…` | Which packs a seat's directive carries, and the directive itself |
| `POST /agents/skills/install` | `{agent, packId}` for a shipped pack, or `{agent, pack}` with the pack inline. `label` picks the directive layer (default `agent`) |
| `POST /agents/skills/remove` | `{agent, packId}` |

The install refuses in three distinguishable ways, because they are fixed in
different places:

- **400** — the pack is malformed. The body lists every reason.
- **409** — a requirement is unmet. The body names the missing flows, connector
  routes and tools; register them and install again.
- **413** — the merged directive would blow the rendered ceiling. Remove a pack
  or shorten a layer.

Both outcomes are audited: `SkillPackInstalled` and `SkillPackRemoved` carry the
pack id, version and counts — never the skill bodies, which the directive itself
serves in full.

## What ships

```bash
lacrew skills list
```

The packs LaCrew ships are the procedure half of verticals that already exist
here: their flows are shipped templates and their connector routes are shipped
presets. That constraint is deliberate — a first-party pack naming a route no
preset serves would be invention presented as configuration.

They carry no `resources`. Which repos, venues or accounts a crew looks after is
your answer, exactly as it is for a [crew blueprint](./crews.md): a pack that
named repositories would be putting somebody else's targets into your directive.
