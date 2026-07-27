import { strict as assert } from "node:assert";
import { test } from "node:test";
import { crewBlueprints, getCrewBlueprint } from "./crewBlueprints.js";
import { crewFlowTemplates } from "./crewTemplates.js";
import {
  bindCrewFlow,
  crewFlowPlaceholders,
  crewMonthlyGrantUsd,
  crewPlan,
  formatUsdc,
  validateCrewBlueprint,
  type CrewBlueprint,
} from "./crews.js";
import { createMockFlowBackend, runFlow } from "./run.js";
import { flowTemplates, getFlowTemplate } from "./templates.js";
import { stepEdges, validateFlow } from "./validate.js";

const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;

/** Bind every seat and target a blueprint names, so plans and flows resolve. */
function fullBindings(bp: CrewBlueprint) {
  const roles: Record<string, string> = { root: ADDR(1) };
  bp.roles.forEach((r, i) => {
    roles[r.id] = ADDR(i + 2);
  });
  const targets: Record<string, string> = {};
  bp.targets.forEach((t, i) => {
    targets[t.id] = ADDR(i + 100);
  });
  const policies: Record<string, string> = {};
  bp.roles.forEach((r, i) => {
    if (r.dedicatedPolicy) policies[r.id] = ADDR(i + 200);
  });
  return { roles, targets, policies };
}

test("every first-party blueprint validates", () => {
  for (const bp of crewBlueprints) {
    const result = validateCrewBlueprint(bp);
    assert.deepEqual(result.errors, [], `${bp.id}: ${result.errors.join("; ")}`);
    assert.equal(result.ok, true);
  }
});

test("blueprints cover the three filled intake personas", () => {
  assert.deepEqual(
    crewBlueprints.map((b) => b.id).sort(),
    ["content-studio", "defi-desk", "github-experts"],
  );
  for (const bp of crewBlueprints) {
    assert.match(bp.intake.file, /^design-partners\/\d+-[a-z-]+\.md$/);
  }
  assert.equal(getCrewBlueprint("defi-desk")?.vertical, "trading");
  assert.equal(getCrewBlueprint("nope"), undefined);
});

test("streamed grants land inside the budget the partner stated", () => {
  for (const bp of crewBlueprints) {
    const monthly = crewMonthlyGrantUsd(bp);
    assert.ok(
      monthly >= bp.budget.monthlyUsdMin && monthly <= bp.budget.monthlyUsdMax,
      `${bp.id}: ${monthly} outside ${bp.budget.monthlyUsdMin}–${bp.budget.monthlyUsdMax}`,
    );
  }
});

test("every crew flow template is a valid flow and is reachable from the catalog", () => {
  for (const tpl of crewFlowTemplates) {
    const result = validateFlow(tpl.definition);
    assert.deepEqual(result.errors, [], `${tpl.id}: ${result.errors.join("; ")}`);
    assert.equal(getFlowTemplate(tpl.id)?.id, tpl.id, `${tpl.id} missing from flowTemplates`);
    assert.equal(getFlowTemplate(tpl.definition.id)?.id, tpl.id);
  }
  // The crew templates extend the gallery rather than replacing it.
  assert.ok(flowTemplates.length > crewFlowTemplates.length);
});

test("flow ids are unique across the whole catalog", () => {
  const ids = flowTemplates.map((t) => t.id);
  const defIds = flowTemplates.map((t) => t.definition.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(defIds).size, defIds.length);
});

test("every seat placeholder in a crew flow names a role in a blueprint that ships it", () => {
  for (const bp of crewBlueprints) {
    const roleIds = new Set(bp.roles.map((r) => r.id));
    const targetIds = new Set(bp.targets.map((t) => t.id));
    for (const flowId of bp.flows) {
      const def = getFlowTemplate(flowId)?.definition;
      assert.ok(def, `${bp.id} ships unknown flow ${flowId}`);
      for (const ref of crewFlowPlaceholders(def!)) {
        const [kind, id] = ref.split(".") as [string, string];
        const known = kind === "crew" ? roleIds.has(id) : targetIds.has(id);
        assert.ok(known, `${bp.id}/${flowId} references unknown ${ref}`);
      }
    }
  }
});

test("a delegated flow is shipped by the same blueprint as its caller", () => {
  for (const bp of crewBlueprints) {
    for (const flowId of bp.flows) {
      const def = getFlowTemplate(flowId)!.definition;
      for (const step of def.steps) {
        if (step.kind === "agent" && step.flowId) {
          assert.ok(
            bp.flows.includes(step.flowId),
            `${bp.id}/${flowId} delegates to ${step.flowId}, which the crew does not install`,
          );
        }
      }
    }
  }
});

test("binding resolves placeholders and refuses to leave one behind", () => {
  const bp = getCrewBlueprint("defi-desk")!;
  const def = getFlowTemplate("desk-execute-trade")!.definition;
  assert.deepEqual(crewFlowPlaceholders(def), ["target.dex-router"]);

  const bound = bindCrewFlow(def, fullBindings(bp));
  assert.deepEqual(crewFlowPlaceholders(bound), []);
  assert.deepEqual(validateFlow(bound).errors, []);
  const gate = bound.steps.find((s) => s.id === "trade");
  assert.equal(gate?.kind === "gate" && gate.target, ADDR(104));
  // The source template is untouched — templates are shared, bindings are not.
  assert.deepEqual(crewFlowPlaceholders(def), ["target.dex-router"]);

  assert.throws(
    () => bindCrewFlow(def, { targets: {} }),
    /unbound_crew_placeholders: target.dex-router/,
  );
});

test("a bound crew flow runs end to end against the mock backend", async () => {
  const bp = getCrewBlueprint("content-studio")!;
  const def = bindCrewFlow(getFlowTemplate("content-daily-social")!.definition, fullBindings(bp));
  const result = await runFlow(def, createMockFlowBackend(), { input: "personal account brief" });
  assert.equal(result.status, "completed");
  assert.ok(result.steps.some((s) => s.kind === "gate"));
  assert.ok(result.steps.every((s) => s.status === "ok"));
});

test("every external call a crew flow makes is declared by its blueprint", () => {
  for (const bp of crewBlueprints) {
    const declared = new Set(bp.connectors.flatMap((c) => c.routes.map((r) => `${c.id}.${r}`)));
    for (const flowId of bp.flows) {
      for (const step of getFlowTemplate(flowId)!.definition.steps) {
        if (step.kind !== "tool" || step.tool.startsWith("lacrew_")) continue;
        assert.ok(
          declared.has(step.tool),
          `${bp.id}/${flowId} calls ${step.tool} with nothing declared to serve it`,
        );
      }
    }
  }

  // A crew that reaches nothing says so with an empty list rather than by
  // omission — "no connectors" and "nobody wrote them down" must not look alike.
  for (const bp of crewBlueprints) {
    assert.ok(Array.isArray(bp.connectors), `${bp.id} must state its connectors`);
  }
});

test("validation catches a flow calling an undeclared connector", () => {
  const bp = structuredClone(getCrewBlueprint("github-experts")!);
  bp.connectors = [];
  const result = validateCrewBlueprint(bp);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /which no declared connector serves/.test(e)));
});

test("the GitHub crew asks policy before it merges, and cannot merge otherwise", () => {
  const def = getFlowTemplate("bot-pr-triage")!.definition;
  const check = def.steps.find((s) => s.id === "merge-check");
  assert.equal(check?.kind === "tool" && check.tool, "lacrew_check_policy");
  // The merge step is reachable only from the branch that read the verdict.
  const reachesMerge = def.steps.filter((s) => JSON.stringify(stepEdges(s)).includes('"merge"'));
  assert.deepEqual(reachesMerge.map((s) => s.id), ["may-merge"]);
  const merge = def.steps.find((s) => s.id === "merge");
  assert.equal(merge?.kind === "tool" && merge.tool, "github.merge_pull_request");
});

test("publication is asked of policy before it is ever proposed", () => {
  // Verified on Anvil: proposing against an unadmitted target reverts with
  // SessionTargetDenied, which fails the run — the sign-off package the deny
  // path exists to produce is never written. Asking first returns DENY and the
  // branch routes on it, so the gate is only reachable once policy admits the
  // endpoint.
  const def = getFlowTemplate("content-weekly-brief")!.definition;
  const check = def.steps.find((s) => s.id === "publish-check");
  assert.equal(check?.kind, "tool");
  assert.equal(check?.kind === "tool" && check.tool, "lacrew_check_policy");

  const reachesGate = def.steps.filter((s) =>
    JSON.stringify(stepEdges(s)).includes('"publish"'),
  );
  assert.deepEqual(
    reachesGate.map((s) => s.id),
    ["publish-allowed"],
    "the publish gate must only be reachable from the policy branch",
  );
  const branch = def.steps.find((s) => s.id === "publish-allowed");
  assert.equal(branch?.kind === "branch" && branch.onFalse, "signoff");
});

test("the plan hires managers before their reports and never loses a seat", () => {
  for (const bp of crewBlueprints) {
    const plan = crewPlan(bp);
    const hires = plan.filter((s) => s.kind === "hire");
    assert.equal(hires.length, bp.roles.length);
    const placed: string[] = [];
    for (const hire of hires) {
      const role = bp.roles.find((r) => r.id === hire.role)!;
      if (role.reportsTo !== "root") {
        assert.ok(
          placed.includes(role.reportsTo),
          `${bp.id}: ${role.id} hired before its manager ${role.reportsTo}`,
        );
      }
      placed.push(role.id);
    }
    assert.deepEqual(
      plan.map((s) => s.order),
      plan.map((_s, i) => i + 1),
    );
  }
});

test("the plan whitelists once per target, org-wide, and says which are denied", () => {
  const bp = getCrewBlueprint("content-studio")!;
  const plan = crewPlan(bp);
  const whitelist = plan.filter((s) => s.kind === "whitelist");
  assert.equal(whitelist.length, bp.targets.length);
  assert.equal(new Set(whitelist.map((s) => s.target)).size, bp.targets.length);
  for (const step of whitelist) {
    assert.equal(step.args.node, undefined, "whitelisting is org-wide, not per node");
  }
  const publish = whitelist.find((s) => s.target === "publish-endpoint")!;
  assert.equal(publish.args.allowed, false);
  assert.match(publish.summary, /denied by design/);
});

test("a seat that needs its own policy stack gets a binding step", () => {
  const plan = crewPlan(getCrewBlueprint("defi-desk")!);
  const bind = plan.filter((s) => s.kind === "bind-policy");
  assert.equal(bind.length, 1);
  assert.equal(bind[0]!.role, "executor");
  assert.equal(bind[0]!.args.action, "set-policy");
  assert.deepEqual(bind[0]!.pending, ["crew.executor", "policy.executor"]);

  // No seat in the GitHub crew needs one, so no step is invented for it.
  assert.equal(crewPlan(getCrewBlueprint("github-experts")!).filter((s) => s.kind === "bind-policy").length, 0);
});

test("plan steps report what is still unbound, and stop reporting it once bound", () => {
  const bp = getCrewBlueprint("github-experts")!;
  const blind = crewPlan(bp);
  assert.ok(blind.every((s) => s.kind !== "hire" || s.pending.length > 0 || s.args.parent));
  assert.ok(blind.some((s) => s.pending.includes("crew.review-lead")));

  const bound = crewPlan(bp, fullBindings(bp));
  assert.deepEqual(
    bound.flatMap((s) => s.pending),
    [],
  );
  for (const step of bound) {
    assert.ok(!JSON.stringify(step.args).includes("{{"), `${step.summary} still carries a placeholder`);
  }
});

test("plans route through real orchestrator surfaces", () => {
  for (const bp of crewBlueprints) {
    for (const step of crewPlan(bp)) {
      if (step.via === "mcp") {
        assert.ok(
          ["lacrew_org_action", "lacrew_set_budget"].includes(step.tool),
          `${bp.id}: unknown MCP tool ${step.tool}`,
        );
      } else {
        assert.equal(step.tool, "POST /flows");
      }
    }
  }
});

test("validation catches a ladder that dead-ends at a manager with a smaller cap", () => {
  const bp = structuredClone(getCrewBlueprint("defi-desk")!);
  bp.roles.find((r) => r.id === "risk-manager")!.capUsdc = "1000000";
  const result = validateCrewBlueprint(bp);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /escalations dead-end/.test(e)));
});

test("validation catches unknown targets, unshipped flows, and orphan targets", () => {
  const bp = structuredClone(getCrewBlueprint("github-experts")!);
  for (const role of bp.roles) role.spends = ["nope"];
  bp.roles[0]!.flows = ["not-a-flow"];
  const result = validateCrewBlueprint(bp);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unknown target "nope"/.test(e)));
  assert.ok(result.errors.some((e) => /the blueprint does not ship/.test(e)));
  assert.ok(result.errors.some((e) => /is listed but no role spends on it/.test(e)));
});

test("validation rejects a worker managing anyone, and a reporting cycle", () => {
  const bp = structuredClone(getCrewBlueprint("content-studio")!);
  bp.roles.find((r) => r.id === "growth-seo")!.reportsTo = "staff-writer";
  assert.ok(
    validateCrewBlueprint(bp).errors.some((e) => /is not a manager/.test(e)),
    "a worker must not be a parent",
  );

  const cyclic = structuredClone(getCrewBlueprint("content-studio")!);
  cyclic.roles.find((r) => r.id === "editor-manager")!.reportsTo = "social-desk";
  cyclic.roles.find((r) => r.id === "social-desk")!.kind = "manager_agent";
  cyclic.roles.find((r) => r.id === "social-desk")!.reportsTo = "editor-manager";
  assert.ok(validateCrewBlueprint(cyclic).errors.some((e) => /reporting cycle/.test(e)));
});

test("a monitoring-only guardrail must state what it does not cover", () => {
  const bp = structuredClone(getCrewBlueprint("defi-desk")!);
  bp.guardrails.push({
    never: "Someone does something clever",
    enforcedBy: "monitoring",
    how: "Guardian flags it",
  });
  assert.ok(
    validateCrewBlueprint(bp).errors.some((e) => /must state its residual risk/.test(e)),
    "monitoring is detection, and a row that omits that reads as prevention",
  );
});

test("validation rejects an escalation ladder that never reaches the human", () => {
  const bp = structuredClone(getCrewBlueprint("defi-desk")!);
  bp.escalation = bp.escalation.filter((r) => r.to !== "human_root");
  assert.ok(validateCrewBlueprint(bp).errors.some((e) => /never reaches the human root/.test(e)));
});

test("formatUsdc renders base units the way a human reads them", () => {
  assert.equal(formatUsdc("200000000"), "200 USDC");
  assert.equal(formatUsdc("1500000"), "1.5 USDC");
  assert.equal(formatUsdc("0"), "0 USDC");
  assert.equal(formatUsdc("not-a-number"), "not-a-number USDC");
});
