/**
 * `lacrew crews …` — read the first-party crew blueprints and the plan that
 * stands one up (F2.13). Fully offline: a blueprint is data, and the point of
 * printing the plan before running anything is that a partner can read what
 * their crew will be allowed to do before a single hire exists.
 *
 * `plan` prints calls, it does not make them. Each line says which surface
 * carries it, which governance tier it rides, and which addresses are still
 * unbound — because a hire's address does not exist until the hire lands.
 */

import { writeFileSync } from "node:fs";
import { getConnectorPreset } from "@lacrew/orchestrator";
import { cmdEval } from "./evals.js";
import {
  crewBlueprints,
  crewChecklist,
  crewChecklistBlocker,
  crewChecklistProgress,
  crewFlowOwner,
  crewMonthlyGrantUsd,
  crewControlRole,
  crewPlan,
  crewSampleInputText,
  crewSampleNeeds,
  crewSampleRun,
  externalSeatRefusal,
  formatUsdc,
  getCrewBlueprint,
  getFlowTemplate,
  resolveCrewSeats,
  resolveExternalSeats,
  validateCrewBlueprint,
  type CrewBlueprint,
  type CrewBindings,
  type CrewCheck,
  type CrewChecklistFacts,
  type CrewExternalCandidate,
  type CrewRole,
} from "@lacrew/flows";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Reporting lines as an indented tree, managers first. */
function printOrgTree(bp: CrewBlueprint): void {
  const children = (parent: string): CrewRole[] => bp.roles.filter((r) => r.reportsTo === parent);
  const walk = (parent: string, depth: number): void => {
    const seats = children(parent);
    seats.forEach((role, i) => {
      const pad = "  ".repeat(depth);
      const kind = role.kind === "manager_agent" ? "manager" : "worker";
      console.log(
        `${pad}${i === seats.length - 1 ? "└─" : "├─"} ${role.label}  (${kind} · cap ${formatUsdc(
          role.capUsdc,
        )} · ${formatUsdc(role.grantUsdc)}/${bp.epoch})`,
      );
      console.log(`${pad}     ${role.charter}`);
      walk(role.id, depth + 1);
    });
  };
  for (const seat of bp.humanSeats) {
    console.log(`● ${seat.label} — ${seat.holds}`);
  }
  walk("root", 0);
}

function printBlueprint(bp: CrewBlueprint): void {
  // The catalog, so an external reference naming a role no sibling blueprint
  // has is reported here rather than at an install that cannot resolve it.
  const check = validateCrewBlueprint(bp, { crews: crewBlueprints });
  console.log(`${bp.name}  (${bp.id} · ${bp.vertical})`);
  console.log(`  ${bp.summary}`);
  console.log(`  From ${bp.intake.file}`);
  console.log(
    `  Budget: ${crewMonthlyGrantUsd(bp)} USDC/month streamed, inside the stated ${
      bp.budget.monthlyUsdMin
    }–${bp.budget.monthlyUsdMax} USD range`,
  );
  console.log(`  ${bp.budget.note}`);

  console.log("\nOrg chart");
  printOrgTree(bp);

  console.log("\nWhere money can go");
  for (const t of bp.targets) {
    console.log(`  ${t.whitelisted ? "allow" : " deny"}  ${t.label} — ${t.note}`);
  }

  console.log("\nAsk-me-first ladder");
  for (const rung of bp.escalation) {
    console.log(`  ${rung.when}\n      → ${rung.to} (${rung.via})`);
  }

  console.log("\nConstitutional changes");
  for (const rule of bp.governance) {
    console.log(`  [${rule.tier.padEnd(4)}] ${rule.change}`);
  }

  console.log("\nMust never happen");
  for (const rail of bp.guardrails) {
    console.log(`  ✗ ${rail.never}\n      ${rail.enforcedBy}: ${rail.how}`);
    if (rail.residualRisk) console.log(`      residual: ${rail.residualRisk}`);
  }

  // Printed before the guardrails' neighbours because it is the one section
  // that is about somebody else's crew: an operator reading this has to decide
  // whether to hand over the authority at all.
  if (bp.externalSeats?.length) {
    console.log("\nSeats in other crews this one may act on");
    for (const seat of bp.externalSeats) {
      console.log(
        `  ${seat.id}  → ${seat.crewBlueprintId ? `${seat.crewBlueprintId}.` : "any crew's "}${seat.roleId}`,
      );
      console.log(`     ${seat.label} — ${seat.authority}`);
    }
    console.log(
      "     Bound at install from the sibling crew's own seat, never typed:  lacrew crews checklist " +
        `${bp.id}`,
    );
  }

  console.log("\nOutside LaCrew's reach");
  for (const scope of bp.externalScopes) {
    console.log(`  ${scope.label} — ${scope.boundary}`);
  }
  for (const line of bp.outOfScope) {
    console.log(`  · ${line}`);
  }

  const printNeeds = (needs: typeof bp.connectors): void => {
    for (const need of needs) {
      console.log(`  ${need.id}  (${need.routes.map((r) => `${need.id}.${r}`).join(", ")})`);
      console.log(`     ${need.note}`);
      // Naming the routes without saying where a definition comes from is how
      // an operator ends up transcribing one out of the docs.
      const preset = getConnectorPreset(need.id);
      console.log(
        preset
          ? `     ships as a preset:  lacrew connectors show ${need.id}`
          : `     no preset ships — register this one by hand (docs: connectors)`,
      );
    }
  };

  // Two lists, because they are two different obligations. The first is what
  // the crew does not work without; the second is a loop the operator closes if
  // they want it. Merging them would send someone to wire a credential for a
  // route nothing calls, and then to wonder why nothing happened.
  const required = bp.connectors.filter((c) => (c.usedBy ?? "flow") === "flow");
  const optional = bp.connectors.filter((c) => (c.usedBy ?? "flow") === "operator");

  if (required.length > 0) {
    console.log("\nConnectors to register before the crew can work");
    printNeeds(required);
  } else {
    console.log("\nConnectors: none required — no shipped flow leaves LaCrew.");
  }

  if (optional.length > 0) {
    console.log("\nConnectors this crew could use — no shipped flow calls them yet");
    printNeeds(optional);
  }

  console.log("\nFlows");
  for (const flowId of bp.flows) {
    const tpl = getFlowTemplate(flowId);
    const runners = bp.roles.filter((r) => r.flows.includes(flowId)).map((r) => r.label);
    console.log(
      `  ${flowId}  "${tpl?.name ?? "unknown"}"${runners.length ? ` · runs as ${runners.join(", ")}` : ""}`,
    );
  }

  /*
    Supervision the blueprint recommends but does not impose (F2.31 / F2.32).

    Printed as an offer with the command that takes it, because the failure of
    the old shape was exactly that the recommendation lived in a guardrail's
    prose: true, unread, and never applied.
  */
  const controls = bp.recommendedControls;
  if (controls) {
    console.log("\nSupervision this blueprint recommends — off unless you apply it");
    const seatLabel = (scope: { level: string; role?: string }): string => {
      const roleId = scope.level === "agent" ? scope.role : crewControlRole(bp);
      return bp.roles.find((r) => r.id === roleId)?.label ?? roleId ?? "the crew";
    };
    if (controls.planRequired) {
      console.log(
        `  plan-required  ${controls.planRequired.mode} on ${seatLabel(controls.planRequired.scope)}`,
      );
      console.log(`     ${controls.planRequired.why}`);
    }
    if (controls.dualControl) {
      const floor = controls.dualControl.minSpend
        ? ` at or above ${formatUsdc(controls.dualControl.minSpend)}`
        : "";
      console.log(
        `  dual control   ${controls.dualControl.mode}${floor} on ${seatLabel(controls.dualControl.scope)}` +
          `${controls.dualControl.reviewer ? ` · reviewer ${controls.dualControl.reviewer}` : ""}`,
      );
      console.log(`     ${controls.dualControl.why}`);
    }
    console.log(`     See the calls:  lacrew crews plan ${bp.id} --apply-recommended-controls`);
  }

  printSample(bp);

  if (!check.ok) {
    console.log("\nBlueprint does not validate:");
    for (const err of check.errors) console.log(`  ✗ ${err}`);
  }
  console.log(`\nPlan it:  lacrew crews plan ${bp.id}`);
}

/**
 * The certified first run, and what has to be wired before it means anything.
 *
 * A blueprint with no fixture says so rather than leaving the section out: the
 * absence is the answer to "how do I check this works", and an operator who
 * reads nothing here should learn that they are choosing the run input
 * themselves, not that the question was never asked.
 */
function printSample(bp: CrewBlueprint, pointer = true): void {
  const sample = crewSampleRun(bp.id);
  console.log("\nFirst run");
  if (!sample) {
    console.log("  No certified sample ships for this blueprint — choose a flow and an input.");
    return;
  }
  const owner = crewFlowOwner(bp, sample.flow);
  const needs = crewSampleNeeds(sample);
  console.log(`  ${sample.flow}${owner ? ` · runs as ${owner.label}` : ""}`);
  console.log(`  ${sample.summary}`);
  console.log(`  ${sample.safety}`);
  if (needs) {
    const wants = [
      ...(needs.model ? ["a model provider key"] : []),
      ...needs.connectors.map((id) => `the ${id} connector`),
    ];
    if (wants.length > 0) {
      console.log(`  Wire first: ${wants.join(", ")} — without them the run returns stub text.`);
    }
  }
  if (pointer) console.log(`  lacrew crews sample ${bp.id}`);
}

/**
 * Bindings from `--bind role=0x…` / `--bind target:model-api=0x…` flags.
 * Unprefixed keys are seats, since seats are the common case.
 */
function parseBindings(args: string[]): CrewBindings {
  const bindings: CrewBindings = { roles: {}, targets: {}, policies: {} };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--bind") continue;
    const raw = args[i + 1];
    if (!raw || !raw.includes("=")) continue;
    const [key, value] = raw.split("=") as [string, string];
    const [prefix, rest] = key.includes(":") ? (key.split(":") as [string, string]) : ["crew", key];
    if (prefix === "target") bindings.targets![rest] = value;
    else if (prefix === "policy") bindings.policies![rest] = value;
    else bindings.roles![rest] = value;
  }
  return bindings;
}

function printPlan(bp: CrewBlueprint, bindings: CrewBindings, controls = false): void {
  const plan = crewPlan(bp, bindings, { applyRecommendedControls: controls });
  console.log(`Plan for ${bp.name} — ${plan.length} steps. Nothing here has been called.\n`);
  for (const step of plan) {
    const tier = step.tier ? ` · ${step.tier} tier` : "";
    console.log(`${String(step.order).padStart(3)}. ${step.summary}`);
    console.log(`     ${step.via === "mcp" ? "mcp" : "http"} ${step.tool}${tier}`);
    if (step.pending.length > 0) {
      console.log(`     needs: ${step.pending.join(", ")}`);
    }
  }
  const unbound = new Set(plan.flatMap((s) => s.pending));
  if (unbound.size > 0) {
    console.log(
      `\n${unbound.size} address${unbound.size === 1 ? "" : "es"} still unbound. A seat's address ` +
        `exists once its hire lands; bind them with --bind <role>=0x… and --bind target:<id>=0x….`,
    );
    // Deliberately not a --bind flag: an external reference resolves from a
    // seat some sibling crew actually hired, and a flag would put the pasted
    // address back — the exact thing the reference exists to replace.
    const external = [...unbound].filter((p) => p.startsWith("external."));
    if (external.length > 0) {
      console.log(
        `${external.join(", ")} ${external.length === 1 ? "names a seat" : "name seats"} in another crew. ` +
          "There is no flag for those: install the sibling crew, record its seats " +
          "(lacrew crews bind <blueprint> --from-org), and the reference resolves to the seat it names.",
      );
    }
  } else {
    console.log("\nEvery address is bound. Run the steps in order against your orchestrator.");
  }
}

/* ------------------------------------------------------------------------- *
 * checklist — the golden path, probed against a running orchestrator.
 * ------------------------------------------------------------------------- */

function orchUrl(args: string[]): string {
  return (flagValue(args, "--url") ?? process.env.ORCH_URL ?? "http://127.0.0.1:8788").replace(
    /\/$/,
    "",
  );
}

/**
 * One probe. Answers `null` on any failure rather than throwing, because a
 * single unreadable surface must degrade one step to `unknown` instead of
 * blanking the list — the difference between "we cannot say" and "it is broken"
 * is the whole reason the checklist has four states.
 */
async function probe<T>(args: string[], path: string): Promise<T | null> {
  const token = process.env.ORCH_TOKEN?.trim();
  try {
    const res = await fetch(`${orchUrl(args)}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * One write. Unlike `probe`, a failure is the answer the caller has to report:
 * a bind that silently did not land is a mapping the operator believes is
 * stored and is not, which is the exact failure this whole record exists to
 * prevent.
 */
async function putJson<T>(args: string[], path: string, body: unknown): Promise<T> {
  const token = process.env.ORCH_TOKEN?.trim();
  const res = await fetch(`${orchUrl(args)}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = (text ? JSON.parse(text) : {}) as T & { error?: string };
  if (!res.ok) throw new Error(parsed.error ?? `orchestrator answered ${res.status}`);
  return parsed;
}

type HealthProbe = {
  mode?: string;
  mocked?: boolean;
  chainId?: number;
  model?: { provider?: string };
};

/**
 * `/connectors` reports credential presence under `auth.ready` — presence only,
 * never the value, since reading a token into a response is how a status
 * surface becomes an exfiltration route.
 */
type ConnectorProbe = { connectors?: Array<{ id: string; auth?: { ready?: boolean } }> };
type FlowsProbe = { flows?: Array<{ id: string }> };
type RunsProbe = { runs?: unknown[] };
type MessagesProbe = { messages?: unknown[] };
/**
 * `/org` carries the blueprint role id on every seat the orchestrator has a
 * binding for (F2.25) — the chain has no room for one, so this is the
 * orchestrator's own record layered over the chart it serves.
 */
type OrgProbe = {
  nodes?: Array<{ account?: string; kind?: string; label?: string; roleId?: string }>;
};

/**
 * The thread the crew talks in.
 *
 * A self-host has no cloud crew record to take an id from, so the blueprint id
 * is the default and `--thread` overrides it. Named in the output either way:
 * "the crew has said nothing" is only useful next to which thread was read.
 */
function threadOf(bp: CrewBlueprint, args: string[]): string {
  const given = flagValue(args, "--thread")?.trim();
  return given || `crew:${bp.id}`;
}

/**
 * Read everything the checklist derives from, in one pass.
 *
 * Seats come from the org chart the orchestrator serves, matched through
 * `resolveCrewSeats` — so a seat renamed since it was hired is still counted
 * when something recorded its role id, and reported as a miss rather than
 * matched to a plausible wrong address when nothing did.
 */
async function probeFacts(
  bp: CrewBlueprint,
  args: string[],
): Promise<{
  facts: CrewChecklistFacts;
  seatsReadable: boolean;
  missingSeats: string[];
  /** Seats that only a typed label found, so nothing has persisted their id. */
  byLabel: string[];
  /** One sentence per external reference nothing bound, in the operator's terms. */
  externalRefusals: string[];
}> {
  const sample = crewSampleRun(bp.id);
  const needs = sample ? crewSampleNeeds(sample) : undefined;
  const [health, connectors, flows, runs, messages, org, bindings] = await Promise.all([
    probe<HealthProbe>(args, "/health"),
    probe<ConnectorProbe>(args, "/connectors"),
    probe<FlowsProbe>(args, "/flows"),
    probe<RunsProbe>(args, "/flows/runs"),
    probe<MessagesProbe>(
      args,
      `/messages?limit=5&thread=${encodeURIComponent(threadOf(bp, args))}`,
    ),
    probe<OrgProbe>(args, "/org"),
    // Unscoped on purpose: an external reference is answered by *another*
    // crew's seats, so narrowing to this blueprint's scope would hide the only
    // rows that could bind it.
    bp.externalSeats?.length ? probe<BindingsResponse>(args, "/crew/bindings") : null,
  ]);

  /*
    Seats come with their role ids attached: the orchestrator persists the
    mapping (`lacrew crews bind`) and layers it onto the chart it serves, so a
    seat renamed after it was hired still resolves without the operator holding
    on to the plan file they installed from.

    `--bind` stays, and it *wins* — it is the operator saying, right now, which
    account a seat is on, against an orchestrator that may have been told
    nothing or told something stale. Same vocabulary `crews plan --bind` uses.
  */
  const bound = parseBindings(args).roles ?? {};
  const roleOf = new Map(
    Object.entries(bound).map(([role, account]) => [account.trim().toLowerCase(), role]),
  );
  const nodes = org?.nodes?.map((n) => {
    const roleId = n.account ? roleOf.get(n.account.trim().toLowerCase()) : undefined;
    return roleId ? { ...n, roleId } : n;
  });
  const seats = nodes ? resolveCrewSeats(bp, nodes) : null;

  /*
    External references resolve from what the orchestrator has recorded about
    *other* crews: role id, the blueprint they were installed from, and the
    account their hire landed on. Nothing here reads an address off the command
    line — a reference that cannot be resolved from a hired seat is reported
    unbound, because the whole point of declaring it was to stop this crew
    halting an account nobody vouched for.
  */
  const candidates: CrewExternalCandidate[] = (bindings?.bindings ?? []).map((b) => ({
    roleId: b.roleId,
    account: b.account,
    ...(b.blueprintId ? { blueprintId: b.blueprintId } : {}),
    ...(b.crewId ? { crewId: b.crewId } : {}),
    ...(b.label ? { label: b.label } : {}),
  }));
  const external = resolveExternalSeats(bp, candidates);
  const externalRefusals = (bp.externalSeats ?? [])
    .map((seat) => externalSeatRefusal(seat, external))
    .filter((line): line is string => Boolean(line));

  return {
    seatsReadable: Boolean(seats),
    missingSeats: seats?.missing ?? [],
    byLabel: seats?.bindings.filter((b) => b.boundBy === "label").map((b) => b.role) ?? [],
    externalRefusals,
    facts: {
      // An unreadable chart reports zero seats, which the seats step renders as
      // the one blocker worth naming: nothing can run as a principal nobody can
      // read. Inventing a count here would be worse.
      seats: {
        total: bp.roles.length,
        withAccount: seats ? bp.roles.filter((r) => seats.roles[r.id]).length : 0,
      },
      runtime: health
        ? health.mode !== "mock" && health.mocked !== true
          ? { live: true }
          : {
              live: false,
              detail:
                "The orchestrator is running in mock mode, so a run returns fabricated data rather than reaching a chain.",
            }
        : null,
      model: health
        ? { configured: Boolean(health.model?.provider && health.model.provider !== "memory") }
        : null,
      connectors: connectors?.connectors
        ? connectors.connectors.map((c) => ({ id: c.id, ready: c.auth?.ready === true }))
        : null,
      installedFlows: flows?.flows ? flows.flows.map((f) => f.id) : null,
      blueprintFlows: bp.flows,
      runs: runs?.runs ? runs.runs.length : null,
      threadMessages: messages?.messages ? messages.messages.length : null,
      sample: sample && needs ? { flow: sample.flow, needs } : null,
      externalUnbound: (bp.externalSeats ?? [])
        .filter((seat) => external.missing.includes(seat.id))
        .map((seat) => seat.label),
    },
  };
}

/* ------------------------------------------------------------------------- *
 * bind — the seat mapping, kept by the orchestrator instead of a plan file.
 * ------------------------------------------------------------------------- */

type BindingsResponse = {
  bindings?: Array<{
    roleId: string;
    account: string;
    label?: string;
    /** Present when the writer knew which crew the seat belongs to. */
    blueprintId?: string;
    crewId?: string;
    at?: string;
  }>;
  roles?: Record<string, string>;
  cleared?: string[];
};

/** `--crew <id>` narrows to one crew; the blueprint id is the scope otherwise. */
function bindScope(bp: CrewBlueprint, args: string[]): { blueprintId: string; crewId?: string } {
  const crewId = flagValue(args, "--crew")?.trim();
  return { blueprintId: bp.id, ...(crewId ? { crewId } : {}) };
}

function bindQuery(scope: { blueprintId: string; crewId?: string }): string {
  const params = new URLSearchParams({ blueprint: scope.blueprintId });
  if (scope.crewId) params.set("crew", scope.crewId);
  return `/crew/bindings?${params.toString()}`;
}

/**
 * Record which account each blueprint seat landed on, on the orchestrator.
 *
 * Three ways in, in the order an operator reaches for them:
 *
 *  - `--bind <role>=0x…` — say it outright. A blank value (`--bind <role>=`)
 *    forgets that seat rather than storing an empty address.
 *  - `--from-org` — read the live chart and persist what a label match found.
 *    This is the one that matters after a hand install: the labels still agree
 *    with the blueprint *now*, and writing the ids down is what makes the next
 *    read survive the first rename.
 *  - neither — print what is stored.
 */
async function cmdBind(bp: CrewBlueprint, args: string[]): Promise<void> {
  const scope = bindScope(bp, args);
  const asked = parseBindings(args).roles ?? {};
  const json = hasFlag(args, "--json");

  let roles: Record<string, string> = { ...asked };
  const labels: Record<string, string> = {};

  if (hasFlag(args, "--from-org")) {
    const org = await probe<OrgProbe>(args, "/org");
    if (!org?.nodes) {
      console.error(`The org chart could not be read from ${orchUrl(args)} — nothing was bound.`);
      process.exitCode = 1;
      return;
    }
    const seats = resolveCrewSeats(bp, org.nodes);
    for (const binding of seats.bindings) {
      // An address the operator typed on this command line outranks one a label
      // match found: they are looking at the crew, and the match is a guess
      // that happens to be checkable.
      if (roles[binding.role]) continue;
      roles[binding.role] = binding.account;
      const label = org.nodes.find(
        (n) => n.account?.trim().toLowerCase() === binding.account.trim().toLowerCase(),
      )?.label;
      if (label) labels[binding.role] = label;
    }
    if (seats.missing.length > 0 && !json) {
      console.log(
        `Seats nothing matched, so nothing was bound for them: ${seats.missing.join(", ")}` +
          `${seats.ambiguous.length > 0 ? ` (${seats.ambiguous.join(", ")} matched two seats each — a plausible wrong address is worse than none)` : ""}`,
      );
    }
  }

  if (Object.keys(roles).length === 0) {
    const stored = await probe<BindingsResponse>(args, bindQuery(scope));
    if (!stored) {
      console.error(
        `The orchestrator at ${orchUrl(args)} did not answer, so what it has bound is unknown.`,
      );
      process.exitCode = 1;
      return;
    }
    if (json) {
      console.log(JSON.stringify(stored, null, 2));
      return;
    }
    printBindings(bp, stored);
    return;
  }

  let result: BindingsResponse;
  try {
    result = await putJson<BindingsResponse>(args, "/crew/bindings", {
      ...scope,
      roles,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    });
  } catch (err) {
    console.error(
      `Nothing was bound: ${err instanceof Error ? err.message : "the orchestrator refused"}.`,
    );
    process.exitCode = 1;
    return;
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.cleared?.length) console.log(`Forgot: ${result.cleared.join(", ")}`);
  printBindings(bp, result);
}

function printBindings(bp: CrewBlueprint, body: BindingsResponse): void {
  const bindings = body.bindings ?? [];
  console.log(
    `${bp.name} — seats bound on the orchestrator  ${bindings.length}/${bp.roles.length}`,
  );
  for (const role of bp.roles) {
    const hit = bindings.find((b) => b.roleId === role.id);
    console.log(
      hit
        ? `  ✓ ${role.id}  ${hit.account}${hit.label && hit.label !== role.label ? `  (hired as "${hit.label}")` : ""}`
        : `  · ${role.id}  unbound — resolves by label until something records it`,
    );
  }
  const extra = bindings.filter((b) => !bp.roles.some((r) => r.id === b.roleId));
  if (extra.length > 0) {
    // Named rather than hidden: a role id this build does not know is either a
    // blueprint that moved on or a typo, and both are the operator's to settle.
    console.log(
      `\n  Bound to role ids this blueprint does not declare: ${extra.map((b) => b.roleId).join(", ")}`,
    );
  }
  console.log("\n  A bound seat is found after a rename. It admits nothing and budgets nothing.");
}

const MARK: Record<CrewCheck["state"], string> = {
  done: "✓",
  blocked: "▲",
  optional: "·",
  unknown: "–",
};

/**
 * Probe a live orchestrator and say whether this crew can do its first run.
 *
 * Exits non-zero when something stands in the way, so a self-host script can
 * gate on it. `run` and `thread` are deliberately not blockers: they are the
 * outcome the checklist drives at, and refusing on "nothing has run yet" would
 * refuse every first run there has ever been.
 */
async function printChecklist(bp: CrewBlueprint, args: string[]): Promise<void> {
  const { facts, seatsReadable, missingSeats, byLabel, externalRefusals } = await probeFacts(
    bp,
    args,
  );
  const steps = crewChecklist(facts);
  const blocker = crewChecklistBlocker(steps);
  const progress = crewChecklistProgress(steps);

  if (hasFlag(args, "--json")) {
    console.log(
      JSON.stringify(
        {
          blueprint: bp.id,
          orchestrator: orchUrl(args),
          steps,
          blocker: blocker?.id ?? null,
          progress,
          ...(externalRefusals.length > 0 ? { externalRefusals } : {}),
        },
        null,
        2,
      ),
    );
    if (blocker) process.exitCode = 1;
    return;
  }

  console.log(`${bp.name} — first run  ${progress.done}/${progress.total}`);
  console.log(`  probing ${orchUrl(args)} · thread ${threadOf(bp, args)}\n`);
  for (const step of steps) {
    console.log(`  ${MARK[step.state]} ${step.title}`);
    console.log(`      ${step.detail}`);
  }
  if (!seatsReadable) {
    console.log("\n  The org chart could not be read, so no seat could be resolved.");
  } else {
    if (missingSeats.length > 0) {
      console.log(
        `\n  Seats nothing matched: ${missingSeats.join(", ")}. A seat renamed after it was hired ` +
          `is found by its stored blueprint role id; without one, only the label can answer.`,
      );
    }
    // Named while everything still works, because that is the only moment it
    // can be fixed cheaply: after the rename, the label these seats were found
    // by is gone and nothing knows where they went.
    if (byLabel.length > 0) {
      console.log(
        `\n  Resolved by label, not by a stored id: ${byLabel.join(", ")}. Rename one and this ` +
          `list loses it — persist the mapping with:  lacrew crews bind ${bp.id} --from-org`,
      );
    }
  }
  // A reference to another crew's seat is the one refusal a human has to
  // resolve by deciding, not by fixing: which crew this one may act on, and
  // whether it should be allowed to at all.
  for (const line of externalRefusals) {
    console.log(`\n  Unbound seat in another crew — ${line}`);
  }
  if (blocker) {
    console.log(`\n  ${blocker.title} is what stands between this crew and its first run.`);
    process.exitCode = 1;
    return;
  }
  const sample = crewSampleRun(bp.id);
  console.log(
    sample
      ? `\n  Nothing is in the way. Fire it:  lacrew crews sample ${bp.id} --json | xargs -0 -I{} lacrew flows run ${sample.flow} --input {}`
      : "\n  Nothing is in the way. This blueprint ships no certified sample, so choose a flow and an input.",
  );
}

export async function cmdCrews(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const id = rest.find((a) => !a.startsWith("-"));

  switch (sub) {
    case undefined:
    case "list": {
      for (const bp of crewBlueprints) {
        console.log(
          `${bp.id}  (${bp.vertical} · ${bp.roles.length} seats · ${bp.flows.length} flows)`,
        );
        console.log(`  ${bp.summary}`);
      }
      console.log(`\nInspect one:  lacrew crews show ${crewBlueprints[0]!.id}`);
      return;
    }

    case "show": {
      const bp = id ? getCrewBlueprint(id) : undefined;
      if (!bp) {
        console.error(
          `Usage: lacrew crews show <id>  (${crewBlueprints.map((b) => b.id).join(", ")})`,
        );
        process.exitCode = 1;
        return;
      }
      if (hasFlag(rest, "--json")) {
        console.log(JSON.stringify(bp, null, 2));
        return;
      }
      printBlueprint(bp);
      return;
    }

    /*
      The run input, on its own, so it can be piped straight into a run rather
      than retyped out of the `show` output. Exits non-zero when the blueprint
      has no fixture: a script asking for one and getting an empty body should
      stop, not run a flow with no input.

      `--json` prints what `POST /flows/run` takes, which is one string either
      way: the JSON body for a flow reading `{{input.<key>}}`, the brief itself
      for one reading the whole `{{input}}`. Serializing the second would hand
      the model a quoted string to read around.
    */
    case "sample": {
      const bp = id ? getCrewBlueprint(id) : undefined;
      if (!bp) {
        console.error(
          `Usage: lacrew crews sample <id> [--json]  (${crewBlueprints.map((b) => b.id).join(", ")})`,
        );
        process.exitCode = 1;
        return;
      }
      const sample = crewSampleRun(bp.id);
      if (!sample) {
        console.error(`No certified sample run ships for "${bp.id}".`);
        process.exitCode = 1;
        return;
      }
      if (hasFlag(rest, "--json")) {
        console.log(crewSampleInputText(sample));
        return;
      }
      printSample(bp, false);
      console.log(
        `\n  lacrew flows run ${sample.flow} --input '${crewSampleInputText(sample)}'` +
          `${crewFlowOwner(bp, sample.flow) ? " --as <that seat's address>" : ""}`,
      );
      return;
    }

    /*
      The same seven checks the hosted crew page renders, asked of a running
      orchestrator instead of a control plane. One derivation behind both
      (`crewChecklist` in `@lacrew/flows`) is what keeps a self-host and the
      cloud from disagreeing about whether a crew is ready.
    */
    case "checklist": {
      const bp = id ? getCrewBlueprint(id) : undefined;
      if (!bp) {
        console.error(
          `Usage: lacrew crews checklist <id> [--url http://…] [--thread crew:…] [--bind <role>=0x…] [--json]  (${crewBlueprints
            .map((b) => b.id)
            .join(", ")})`,
        );
        process.exitCode = 1;
        return;
      }
      await printChecklist(bp, rest);
      return;
    }

    /*
      The mapping that used to live in whatever plan file the operator
      installed from, kept by the orchestrator instead (F2.25). Losing the file
      no longer loses the crew's seats, and a rename stops being the thing that
      quietly unbinds a flow.
    */
    case "bind": {
      const bp = id ? getCrewBlueprint(id) : undefined;
      if (!bp) {
        console.error(
          `Usage: lacrew crews bind <id> [--bind <role>=0x…] [--from-org] [--crew <id>] [--url http://…] [--json]  (${crewBlueprints
            .map((b) => b.id)
            .join(", ")})`,
        );
        process.exitCode = 1;
        return;
      }
      await cmdBind(bp, rest);
      return;
    }

    case "plan": {
      const bp = id ? getCrewBlueprint(id) : undefined;
      if (!bp) {
        console.error(
          `Usage: lacrew crews plan <id> [--bind <role>=0x…] [--apply-recommended-controls] [--json] [--out <file>]  (${crewBlueprints
            .map((b) => b.id)
            .join(", ")})`,
        );
        process.exitCode = 1;
        return;
      }
      const bindings = parseBindings(rest);
      // Opt-in, exactly as the install is: printing a plan that quietly
      // included supervision would misreport what a crew stands up as.
      const controls = hasFlag(rest, "--apply-recommended-controls");
      const plan = crewPlan(bp, bindings, { applyRecommendedControls: controls });
      const out = flagValue(rest, "--out");
      if (out) {
        writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
        console.log(`Wrote ${plan.length} plan steps → ${out}`);
        return;
      }
      if (hasFlag(rest, "--json")) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      printPlan(bp, bindings, controls);
      return;
    }

    /*
      The crew's guarantees, checked (F2.29). A blueprint's summary claims the
      desk cannot trade or that merging needs an admitted authority; `eval` runs
      the scenarios that hold it to that, offline and against fakes.
    */
    case "eval": {
      await cmdEval(rest, "crews");
      return;
    }

    default:
      console.log(`Usage: lacrew crews <list|show|sample|checklist|bind|plan|eval>

  list                       First-party crew blueprints
  show <id> [--json]         Org chart, budgets, ladder, guardrails, flows
  sample <id> [--json]       The certified first run and its input
  checklist <id> [--json]    Probe a running orchestrator for what the first run
        [--url] [--thread]   still needs. Exits non-zero while anything blocks.
        [--bind <role>=0x…]  Override the account a seat landed on for this read;
                             the orchestrator's own bindings answer otherwise.
  bind <id> [--from-org]     Record on the orchestrator which account each seat
        [--bind <role>=0x…]  landed on, so a renamed seat still resolves. With
        [--crew <id>]        neither flag, prints what is stored. An empty value
        [--json]             (--bind <role>=) forgets one seat.
  plan <id> [--bind k=0x…]   The ordered calls that stand the crew up
        [--json] [--out f]   Bind seats as <role>=0x…, targets as target:<id>=0x…
        [--apply-recommended-controls]
                             Also emit the blueprint's recommended supervision
                             (plan-required / dual control). Off by default:
                             recommending a control and turning one on for
                             somebody are different acts.
  eval [id…] [--list]        Run the crew's eval scenarios offline; a failure
        [--json]             names the scenario, the assertion, and the diff

Env: ORCH_URL (or --url, default http://127.0.0.1:8788), ORCH_TOKEN
`);
  }
}
