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
import {
  crewBlueprints,
  crewMonthlyGrantUsd,
  crewPlan,
  formatUsdc,
  getCrewBlueprint,
  getFlowTemplate,
  validateCrewBlueprint,
  type CrewBlueprint,
  type CrewBindings,
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
  const children = (parent: string): CrewRole[] =>
    bp.roles.filter((r) => r.reportsTo === parent);
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
  const check = validateCrewBlueprint(bp);
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

  console.log("\nOutside LaCrew's reach");
  for (const scope of bp.externalScopes) {
    console.log(`  ${scope.label} — ${scope.boundary}`);
  }
  for (const line of bp.outOfScope) {
    console.log(`  · ${line}`);
  }

  console.log("\nFlows");
  for (const flowId of bp.flows) {
    const tpl = getFlowTemplate(flowId);
    const runners = bp.roles.filter((r) => r.flows.includes(flowId)).map((r) => r.label);
    console.log(
      `  ${flowId}  "${tpl?.name ?? "unknown"}"${runners.length ? ` · runs as ${runners.join(", ")}` : ""}`,
    );
  }

  if (!check.ok) {
    console.log("\nBlueprint does not validate:");
    for (const err of check.errors) console.log(`  ✗ ${err}`);
  }
  console.log(`\nPlan it:  lacrew crews plan ${bp.id}`);
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
    const [prefix, rest] = key.includes(":")
      ? (key.split(":") as [string, string])
      : ["crew", key];
    if (prefix === "target") bindings.targets![rest] = value;
    else if (prefix === "policy") bindings.policies![rest] = value;
    else bindings.roles![rest] = value;
  }
  return bindings;
}

function printPlan(bp: CrewBlueprint, bindings: CrewBindings): void {
  const plan = crewPlan(bp, bindings);
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
  } else {
    console.log("\nEvery address is bound. Run the steps in order against your orchestrator.");
  }
}

export function cmdCrews(args: string[]): void {
  const [sub, ...rest] = args;
  const id = rest.find((a) => !a.startsWith("-"));

  switch (sub) {
    case undefined:
    case "list": {
      for (const bp of crewBlueprints) {
        console.log(`${bp.id}  (${bp.vertical} · ${bp.roles.length} seats · ${bp.flows.length} flows)`);
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

    case "plan": {
      const bp = id ? getCrewBlueprint(id) : undefined;
      if (!bp) {
        console.error(
          `Usage: lacrew crews plan <id> [--bind <role>=0x…] [--json] [--out <file>]  (${crewBlueprints
            .map((b) => b.id)
            .join(", ")})`,
        );
        process.exitCode = 1;
        return;
      }
      const bindings = parseBindings(rest);
      const plan = crewPlan(bp, bindings);
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
      printPlan(bp, bindings);
      return;
    }

    default:
      console.log(`Usage: lacrew crews <list|show|plan>

  list                       First-party crew blueprints
  show <id> [--json]         Org chart, budgets, ladder, guardrails, flows
  plan <id> [--bind k=0x…]   The ordered calls that stand the crew up
        [--json] [--out f]   Bind seats as <role>=0x…, targets as target:<id>=0x…
`);
  }
}
