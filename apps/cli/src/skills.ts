/**
 * `lacrew skills …` — the skill packs that ship, and installing one onto a seat
 * (F2.23).
 *
 * `list` and `show` are offline: a pack is data, and reading one before it goes
 * anywhere near an agent is the point of a format. Everything else talks to a
 * running orchestrator, because whether a pack is installable depends on what
 * *that* deployment has registered, and the directive it writes to lives there.
 *
 * `install` accepts a shipped pack by id or a file by path — the same two paths
 * a UI has, so a self-hosted operator is not the one who has to paste JSON into
 * a curl. `export` writes a seat's skills back out as a pack, which is how a
 * hand-written procedure becomes something a second seat can have.
 */

import { readFileSync } from "node:fs";
import {
  diffSkillPack,
  exportSkillPack,
  firstPartySkillPacks,
  getSkillPack,
  parseSkillPack,
  type BriefLayer,
  type SkillPack,
} from "@lacrew/flows";

type PackListing = {
  id: string;
  version: string;
  name: string;
  summary: string;
  scope: string;
  skills: Array<{ id: string; name: string; trigger: string }>;
  requires: { flows?: string[]; connectors?: string[]; mcpTools?: string[] };
  missing: { flows: string[]; connectors: string[]; mcpTools: string[] };
  installable: boolean;
};

type InstalledRow = {
  pack: string;
  version: string;
  label: string;
  skills: number;
  skillIds: string[];
};

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

function orchUrl(args: string[]): string {
  return (flagValue(args, "--url") ?? process.env.ORCH_URL ?? "http://127.0.0.1:8788").replace(
    /\/$/,
    "",
  );
}

async function orchFetch<T>(args: string[], path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.ORCH_TOKEN?.trim();
  const res = await fetch(`${orchUrl(args)}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    errors?: string[];
    missing?: { flows: string[]; connectors: string[]; mcpTools: string[] };
  };
  if (!res.ok) {
    const detail = body.errors?.length ? `\n  ${body.errors.join("\n  ")}` : "";
    throw new Error(`${body.error ?? `${res.status} ${res.statusText}`}${detail}`);
  }
  return body;
}

function printPack(pack: SkillPack): void {
  console.log(`${pack.name}  (${pack.id} ${pack.version}, ${pack.scope} scope)\n`);
  if (pack.summary) console.log(`${pack.summary}\n`);
  const requires = pack.requires ?? {};
  if (requires.flows?.length) console.log(`Flows       ${requires.flows.join(", ")}`);
  if (requires.connectors?.length) console.log(`Connectors  ${requires.connectors.join(", ")}`);
  if (requires.mcpTools?.length) console.log(`Tools       ${requires.mcpTools.join(", ")}`);
  console.log(`\nSkills (${pack.skills.length})`);
  for (const skill of pack.skills) {
    console.log(`\n  ${skill.name}  [${skill.id}]`);
    console.log(`  Use when: ${skill.trigger}`);
    for (const line of skill.body.split("\n")) console.log(`    ${line}`);
  }
  console.log("\nInstall:  lacrew skills install " + pack.id + " --agent 0x…");
}

/** A pack from `--file <path>`, or a shipped one by id. */
function resolvePack(idOrNothing: string | undefined, args: string[]): SkillPack {
  const file = flagValue(args, "--file");
  if (file) {
    const parsed = parseSkillPack(readFileSync(file, "utf8"));
    if (!parsed.pack)
      throw new Error(`${file} is not a valid skill pack:\n  ${parsed.errors.join("\n  ")}`);
    return parsed.pack;
  }
  if (!idOrNothing) throw new Error("Name a shipped pack id, or pass --file <path>.");
  const pack = getSkillPack(idOrNothing);
  if (!pack) {
    throw new Error(
      `Unknown pack "${idOrNothing}". Ships: ${firstPartySkillPacks.map((p) => p.id).join(", ")}`,
    );
  }
  return pack;
}

function printLocalList(): void {
  console.log("Skill packs that ship\n");
  for (const pack of firstPartySkillPacks) {
    console.log(`  ${pack.id}  —  ${pack.name} (${pack.version})`);
    console.log(`     ${pack.summary}`);
    console.log(`     ${pack.skills.length} skills · scope ${pack.scope}`);
    console.log("");
  }
  console.log("Detail:   lacrew skills show <id>");
  console.log(
    "Live:     lacrew skills list --url http://…   (adds what this deployment is missing)",
  );
}

async function printLiveList(args: string[]): Promise<void> {
  const body = await orchFetch<{ packs: PackListing[] }>(args, "/skills/packs");
  console.log("Skill packs on this orchestrator\n");
  for (const pack of body.packs) {
    console.log(`  ${pack.installable ? "✓" : "✗"} ${pack.id}  —  ${pack.name} (${pack.version})`);
    console.log(`     ${pack.summary}`);
    if (!pack.installable) {
      // Named per dimension because they are fixed in different places: a flow
      // is saved here, a connector is registered with a credential.
      if (pack.missing.flows.length)
        console.log(`     missing flows: ${pack.missing.flows.join(", ")}`);
      if (pack.missing.connectors.length)
        console.log(`     missing connectors: ${pack.missing.connectors.join(", ")}`);
      if (pack.missing.mcpTools.length)
        console.log(`     missing tools: ${pack.missing.mcpTools.join(", ")}`);
    }
    console.log("");
  }
}

async function printInstalled(args: string[], agent: string): Promise<void> {
  const body = await orchFetch<{ packs: InstalledRow[] }>(args, `/agents/skills?agent=${agent}`);
  if (body.packs.length === 0) {
    console.log(`No skill pack is installed on ${agent}.`);
    return;
  }
  console.log(`Installed on ${agent}\n`);
  for (const row of body.packs) {
    console.log(`  ${row.pack} ${row.version}  on layer "${row.label}"  (${row.skills} skills)`);
    console.log(`     ${row.skillIds.join(", ")}`);
  }
}

/**
 * What an install would change on a seat that may already carry the pack.
 *
 * Read before the write, which is the only order in which the answer is worth
 * anything: `install` reports a replaced count, and a count does not tell an
 * operator that the merge procedure they rely on now says something else.
 */
async function printDiff(args: string[], agent: string, pack: SkillPack): Promise<void> {
  const body = await orchFetch<{ brief: { layers: BriefLayer[] } | null }>(
    args,
    `/agents/skills?agent=${agent}`,
  );
  const diff = diffSkillPack(body.brief?.layers ?? [], pack);
  if (diff.from === null) {
    console.log(
      `${pack.id} is not installed on ${agent}. Installing adds ${pack.skills.length} skills:\n`,
    );
  } else if (diff.from === diff.to) {
    console.log(
      `${pack.id} ${diff.from} is installed on ${agent}; re-installing the same version.\n`,
    );
  } else {
    console.log(`${pack.id}: ${diff.from} → ${diff.to} on ${agent}\n`);
  }
  const mark = { added: "+", removed: "-", changed: "~", unchanged: " " } as const;
  for (const entry of diff.entries) {
    const detail = entry.fields.length > 0 ? `  (${entry.fields.join(", ")})` : "";
    console.log(`  ${mark[entry.status]} ${entry.name}  [${entry.skill}]${detail}`);
  }
  console.log(
    `\n${diff.added} added · ${diff.changed} changed · ${diff.removed} removed · ${diff.unchanged} unchanged`,
  );
  // Named because it is the one an operator does not expect: installing writes
  // this pack's skills and clears what the old version left, so a skill dropped
  // between versions leaves the directive without anything asking.
  if (diff.removed > 0) {
    console.log("Removed skills go away on install. Hand-written skills are untouched.");
  }
}

export async function cmdSkills(args: string[]): Promise<void> {
  const [sub = "help", ...rest] = args;
  const agent = flagValue(args, "--agent");

  if (sub === "list") {
    if (args.includes("--url") || process.env.ORCH_URL) await printLiveList(args);
    else printLocalList();
    return;
  }

  if (sub === "show") {
    printPack(resolvePack(rest[0], args));
    return;
  }

  if (sub === "installed") {
    if (!agent) throw new Error("lacrew skills installed --agent 0x…");
    await printInstalled(args, agent);
    return;
  }

  if (sub === "diff") {
    if (!agent) throw new Error("lacrew skills diff <id|--file pack.json> --agent 0x…");
    await printDiff(args, agent, resolvePack(rest[0]?.startsWith("-") ? undefined : rest[0], args));
    return;
  }

  if (sub === "install") {
    if (!agent) throw new Error("lacrew skills install <id|--file pack.json> --agent 0x…");
    const pack = resolvePack(rest[0]?.startsWith("-") ? undefined : rest[0], args);
    const label = flagValue(args, "--layer");
    // The pack travels inline even when it ships here, so the orchestrator
    // validates the bytes it is about to install rather than a name it trusts.
    const body = await orchFetch<{
      pack: string;
      version: string;
      label: string;
      installed: number;
      replaced: number;
    }>(args, "/agents/skills/install", {
      method: "POST",
      body: JSON.stringify({ agent, pack, ...(label ? { label } : {}) }),
    });
    console.log(
      `Installed ${body.pack} ${body.version} on ${agent} (layer "${body.label}"): ` +
        `${body.installed} skills${body.replaced > 0 ? `, replacing ${body.replaced}` : ""}.`,
    );
    console.log(
      "A skill is instruction, not authority — caps, whitelists and session scopes are unchanged.",
    );
    return;
  }

  if (sub === "export") {
    if (!agent) throw new Error("lacrew skills export --agent 0x… --id <pack-id>");
    const id = flagValue(args, "--id");
    if (!id) throw new Error("Name the pack this export becomes: --id <pack-id>");
    const body = await orchFetch<{ brief: { layers: BriefLayer[] } | null }>(
      args,
      `/agents/skills?agent=${agent}`,
    );
    const layers = body.brief?.layers ?? [];
    const pack = exportSkillPack(layers, {
      id,
      version: flagValue(args, "--version") ?? "1.0.0",
      name: flagValue(args, "--name") ?? id,
      ...(flagValue(args, "--summary") ? { summary: flagValue(args, "--summary")! } : {}),
      ...(flagValue(args, "--layer") ? { label: flagValue(args, "--layer")! } : {}),
    });
    if (pack.skills.length === 0) throw new Error(`${agent} has no skills to export.`);
    // Printed rather than written: where a pack lands is the operator's call,
    // and a command that wrote files would need to answer "overwrite?" here.
    console.log(JSON.stringify(pack, null, 2));
    return;
  }

  if (sub === "remove") {
    if (!agent) throw new Error("lacrew skills remove <packId> --agent 0x…");
    const packId = rest[0];
    if (!packId) throw new Error("Name the pack to remove.");
    const body = await orchFetch<{ removed: number }>(args, "/agents/skills/remove", {
      method: "POST",
      body: JSON.stringify({ agent, packId }),
    });
    console.log(
      body.removed > 0
        ? `Removed ${body.removed} skills of ${packId} from ${agent}. Hand-written skills were left alone.`
        : `${packId} was not installed on ${agent}. Nothing changed.`,
    );
    return;
  }

  console.log(`lacrew skills — installable directive skills (F2.23)

Offline:
  list                      Packs that ship with LaCrew
  show <id> | --file <p>    A pack's skills, triggers and requirements

Against a running orchestrator (ORCH_URL / --url, token via ORCH_TOKEN):
  list                      Adds what this deployment is missing per pack
  installed --agent 0x…     Packs currently on a seat's directive
  diff <id> --agent 0x…     What installing it would add, change and remove
  install <id> --agent 0x…  Install a shipped pack
  install --file p.json --agent 0x…   Install a pack from a file
  remove <id> --agent 0x…   Remove that pack's skills, keeping hand-written ones
  export --agent 0x… --id <pack-id>   A seat's skills as a pack, on stdout

Flags:
  --agent 0x…               The seat whose directive is written
  --layer <label>           Directive layer to install onto (default "agent")
  --file <path>             A pack JSON file instead of a shipped id
  --id / --version / --name / --summary   Pack fields for export
  --url <base>              Orchestrator base URL

An install is refused, never trimmed: if a pack requires a flow, connector route
or tool this deployment does not have, nothing is written and the refusal names
what is missing. Installing changes no cap, whitelist, session scope or policy.

Env:
  ORCH_URL     Orchestrator base URL (default http://127.0.0.1:8788)
  ORCH_TOKEN   Bearer token (pairs with LACREW_ORCH_TOKEN)`);
}
