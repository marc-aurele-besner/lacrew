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
    // With the catalog, so an external reference naming a role no sibling
    // blueprint has fails here rather than at an install that cannot resolve it.
    const result = validateCrewBlueprint(bp, { crews: crewBlueprints });
    assert.deepEqual(result.errors, [], `${bp.id}: ${result.errors.join("; ")}`);
    assert.equal(result.ok, true);
  }
});

test("blueprints keep partner-derived numbers distinguishable from drafted ones", () => {
  assert.deepEqual(crewBlueprints.map((b) => b.id).sort(), [
    "content-studio",
    "defi-desk",
    "github-experts",
    "governance-desk",
    "lp-advisor",
    "platform-oncall",
    "research-desk",
    "risk-watch",
    "support-desk",
    "yield-desk",
  ]);

  // Three trace to a filled intake: every number in them answers a question a
  // real operator was asked.
  const partnerDerived = ["defi-desk", "github-experts", "content-studio"];
  for (const id of partnerDerived) {
    assert.match(getCrewBlueprint(id)!.intake.file!, /^design-partners\/\d+-[a-z-]+\.md$/);
  }

  // The rest are author-drafted patterns. The absence is the honest signal —
  // pointing them at a document that does not exist would lend partner-derived
  // authority to a guess.
  for (const bp of crewBlueprints.filter((b) => !partnerDerived.includes(b.id))) {
    assert.equal(bp.intake.file, undefined, `${bp.id} claims an intake file`);
    assert.ok(bp.intake.persona.trim(), `${bp.id} has no persona`);
  }

  assert.equal(getCrewBlueprint("defi-desk")?.vertical, "trading");
  assert.equal(getCrewBlueprint("nope"), undefined);
});

test("every blueprint says what it looks after, with a field shape of its own", () => {
  for (const bp of crewBlueprints) {
    const cares = bp.caresFor;
    assert.ok(cares, `${bp.id} declares no caresFor`);
    // "owner/repo" is meaningless to a trading desk and a pool address is
    // meaningless to a maintainer. One placeholder across all of them asks
    // every operator to translate an example from somebody else's job.
    assert.ok(cares!.placeholder.trim(), `${bp.id} has no placeholder`);
    assert.ok(cares!.notePlaceholder.trim(), `${bp.id} has no note placeholder`);
  }

  const placeholders = crewBlueprints.map((b) => b.caresFor!.placeholder);
  assert.equal(
    new Set(placeholders).size,
    placeholders.length,
    "two blueprints share a placeholder",
  );
});

test("every blueprint puts its own manager between the root and its workers", () => {
  for (const bp of crewBlueprints) {
    const managers = bp.roles.filter((r) => r.kind === "manager_agent");
    assert.ok(managers.length >= 1, `${bp.id} has no manager`);
    // Workers reporting straight to root is what flattens an org once a second
    // crew is installed: every seat from every template ends up siblings.
    for (const worker of bp.roles.filter((r) => r.kind === "worker_agent")) {
      assert.notEqual(
        worker.reportsTo,
        "root",
        `${bp.id}: worker "${worker.id}" reports to root rather than a crew manager`,
      );
    }
  }
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
    // A seat in another crew is the one reference a blueprint resolves against
    // something it does not own, so it has to be declared before a flow may
    // name it — the whole point of `externalSeats`.
    const externalIds = new Set((bp.externalSeats ?? []).map((s) => s.id));
    for (const flowId of bp.flows) {
      const def = getFlowTemplate(flowId)?.definition;
      assert.ok(def, `${bp.id} ships unknown flow ${flowId}`);
      for (const ref of crewFlowPlaceholders(def!)) {
        const [kind, id] = ref.split(".") as [string, string];
        const known =
          kind === "crew"
            ? roleIds.has(id)
            : kind === "external"
              ? externalIds.has(id)
              : targetIds.has(id);
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

test("validation catches a connector declared as called that no flow calls", () => {
  // The mirror of the rule above. Without it, `usedBy: "flow"` decays into a
  // wish list and `crews show` sends an operator to register a credential for a
  // route nothing will ever use.
  const bp = structuredClone(getCrewBlueprint("content-studio")!);
  bp.connectors = bp.connectors.map((c) => ({ ...c, usedBy: "flow" as const }));
  const result = validateCrewBlueprint(bp);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /no shipped flow calls it/.test(e)));

  // Omitting the field must not weaken the check — the strict reading is the
  // default, so a need added without thinking about it is caught.
  const omitted = structuredClone(getCrewBlueprint("content-studio")!);
  omitted.connectors = omitted.connectors.map(({ usedBy: _usedBy, ...rest }) => rest);
  assert.equal(validateCrewBlueprint(omitted).ok, false);
});

test("a crew that declares a connector no flow calls says which it is", () => {
  // The studio and the desk both produce something a human then moves by hand.
  // Declaring the surfaces is how an operator learns what closing that loop
  // takes; marking them keeps it distinct from what the crew cannot run without.
  for (const id of ["content-studio", "defi-desk"]) {
    const bp = getCrewBlueprint(id)!;
    assert.ok(bp.connectors.length > 0, `${id} declares no connectors`);
    assert.ok(
      bp.connectors.every((c) => c.usedBy === "operator"),
      `${id} claims a flow calls a connector`,
    );
    assert.equal(validateCrewBlueprint(bp).ok, true);
  }

  // github-experts is the other case: its triage flow genuinely calls GitHub,
  // so the crew does not work until that one is registered.
  const dev = getCrewBlueprint("github-experts")!;
  assert.deepEqual(
    dev.connectors.filter((c) => (c.usedBy ?? "flow") === "flow").map((c) => c.id),
    ["github"],
  );
});

test("the advisory crew has nowhere to trade and nowhere to withdraw", () => {
  // The whole claim of `lp-advisor` is structural rather than stated: it does
  // not decline to trade, it has no admitted target to trade against. A venue
  // or payout quietly flipped to `true` here would turn an advisory crew into
  // a trading one without changing a word of its summary.
  const bp = getCrewBlueprint("lp-advisor")!;
  const spendable = bp.targets.filter((t) => t.kind !== "service");
  assert.ok(spendable.length > 0, "lp-advisor lists no venue or payout to refuse");
  for (const target of spendable) {
    assert.equal(target.whitelisted, false, `lp-advisor admits ${target.kind} "${target.id}"`);
  }

  // And the refusal is exercised rather than assumed: the flow asks about the
  // router it expects to be denied on, so an admission shows up as an alert.
  const def = getFlowTemplate("lp-range-review")!.definition;
  assert.ok(
    crewFlowPlaceholders(def).includes("target.dex-router"),
    "the review flow never asks policy about the venue it must not reach",
  );
});

test("the seat the risk watch may halt is declared, not handed to a run", () => {
  const bp = getCrewBlueprint("risk-watch")!;
  const def = getFlowTemplate("risk-sweep")!.definition;

  // The halt names the blueprint's declared reference. A run input here is the
  // shape this replaced: an address nothing checks, deactivated on sight.
  const halt = def.steps.find((s) => s.id === "halt-sibling");
  assert.equal(halt?.kind === "org" && halt.node, "{{external.desk-executor}}");
  assert.ok(crewFlowPlaceholders(def).includes("external.desk-executor"));
  assert.ok(
    !JSON.stringify(def.steps).includes("{{input.executor}}"),
    "the sweep still takes an executor address as a run input",
  );

  // And binding resolves it like any other reference — the address comes from
  // the desk's own seat, wherever the caller read that from.
  const bound = bindCrewFlow(def, {
    ...fullBindings(bp),
    external: { "desk-executor": ADDR(900) },
  });
  const boundHalt = bound.steps.find((s) => s.id === "halt-sibling");
  assert.equal(boundHalt?.kind === "org" && boundHalt.node, ADDR(900));

  assert.throws(
    () => bindCrewFlow(def, fullBindings(bp)),
    /unbound_crew_placeholders: external.desk-executor/,
  );
});

test("a plan reports an unbound external reference as work still outstanding", () => {
  const bp = getCrewBlueprint("risk-watch")!;
  const install = crewPlan(bp, fullBindings(bp)).find((s) => s.kind === "install-flow");
  assert.deepEqual(install?.pending, ["external.desk-executor"]);

  const bound = crewPlan(bp, {
    ...fullBindings(bp),
    external: { "desk-executor": ADDR(900) },
  }).find((s) => s.kind === "install-flow");
  assert.deepEqual(bound?.pending, []);
});

test("validation refuses an external reference nothing declares", () => {
  const bp = structuredClone(getCrewBlueprint("risk-watch")!);
  delete bp.externalSeats;
  const result = validateCrewBlueprint(bp);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /does not declare as an external seat/.test(e)));
});

test("validation refuses a declared external reference no flow binds", () => {
  // The mirror rule. Without it, a blueprint could ask an operator to hand over
  // authority over another crew's seat that nothing was ever going to use.
  const bp = structuredClone(getCrewBlueprint("risk-watch")!);
  bp.externalSeats!.push({
    id: "unused-seat",
    label: "A seat nothing acts on",
    crewBlueprintId: "defi-desk",
    roleId: "rebalancer",
    authority: "Nothing at all.",
  });
  const result = validateCrewBlueprint(bp);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /no shipped flow binds it/.test(e)));
});

test("validation refuses a reference to a role the sibling blueprint does not have", () => {
  const bp = structuredClone(getCrewBlueprint("risk-watch")!);
  bp.externalSeats![0]!.roleId = "trader";
  const result = validateCrewBlueprint(bp, { crews: crewBlueprints });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /"defi-desk" does not have/.test(e)));

  // Without the catalog the claim is simply uncheckable, and validation says
  // what it can rather than inventing an answer.
  assert.ok(
    !validateCrewBlueprint(bp).errors.some((e) => /does not have/.test(e)),
    "a lone blueprint claimed to know another one's roles",
  );

  const unknown = structuredClone(getCrewBlueprint("risk-watch")!);
  unknown.externalSeats![0]!.crewBlueprintId = "no-such-crew";
  assert.ok(
    validateCrewBlueprint(unknown, { crews: crewBlueprints }).errors.some((e) =>
      /unknown blueprint/.test(e),
    ),
  );
});

test("validation refuses a blueprint declaring one of its own seats as external", () => {
  const bp = structuredClone(getCrewBlueprint("risk-watch")!);
  bp.externalSeats![0]!.crewBlueprintId = "risk-watch";
  bp.externalSeats![0]!.roleId = "peg-watch";
  const result = validateCrewBlueprint(bp, { crews: crewBlueprints });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /binds as \{\{crew\./.test(e)));
});

test("an external reference must say what the crew does with it", () => {
  const bp = structuredClone(getCrewBlueprint("risk-watch")!);
  bp.externalSeats![0]!.authority = "  ";
  assert.ok(
    validateCrewBlueprint(bp).errors.some((e) => /must state what this crew does with it/.test(e)),
  );
});

test("the runtime refuses an org action still carrying a reference nobody bound", async () => {
  // Belt to the install's braces. `bindCrewFlow` throws at install, but a
  // definition saved some other way would reach the runtime, where an
  // unresolved reference interpolates to "" — an account, and one nobody
  // chose. Deactivating it is not a no-op to learn about from a chain revert.
  const def = getFlowTemplate("risk-sweep")!.definition;
  const halt = def.steps.find((s) => s.id === "halt-sibling");
  assert.equal(halt?.kind, "org");
  const run = await runFlow(
    {
      id: "unbound",
      name: "unbound",
      steps: [
        {
          id: "halt-sibling",
          kind: "org",
          action: "deactivate",
          node: halt?.kind === "org" ? halt.node : "",
          onAllow: null,
          onEscalate: null,
          onDeny: null,
        },
      ],
    },
    createMockFlowBackend(),
  );
  assert.equal(run.status, "error");
  assert.match(run.steps[0]!.error!, /unbound_crew_placeholder:halt-sibling.node/);
});

test("the risk watch states the residual risk on every guardrail it has", () => {
  // Validation only demands this of `monitoring` rails. This crew claims to
  // detect rather than prevent, so every rail owes the reader what it still
  // does not cover — including the ones enforced onchain.
  const bp = getCrewBlueprint("risk-watch")!;
  for (const rail of bp.guardrails) {
    assert.ok(
      rail.residualRisk?.trim(),
      `risk-watch guardrail "${rail.never}" claims prevention without stating its gap`,
    );
  }
});

test("the DeFi patterns declare the connectors their own flows call", () => {
  // The counterpart to the studio and the desk above: these four ship a
  // pipeline that genuinely leaves LaCrew, so `usedBy: "flow"` is a claim the
  // flow has to back.
  for (const id of ["lp-advisor", "yield-desk", "risk-watch", "governance-desk"]) {
    const bp = getCrewBlueprint(id)!;
    const needed = bp.connectors.filter((c) => (c.usedBy ?? "flow") === "flow");
    assert.ok(needed.length > 0, `${id} ships a flow but needs no connector`);

    const called = new Set(
      bp.flows.flatMap((flowId) =>
        getFlowTemplate(flowId)!.definition.steps.flatMap((s) =>
          s.kind === "tool" && !s.tool.startsWith("lacrew_") ? [s.tool] : [],
        ),
      ),
    );
    for (const need of needed) {
      for (const route of need.routes) {
        assert.ok(called.has(`${need.id}.${route}`), `${id} declares ${need.id}.${route} uncalled`);
      }
    }
  }
});

test("the governance desk discovers its own proposals, and stops short of casting", () => {
  // The desk's whole gap was that it reasoned over a proposal a human pasted
  // in. `governance-proposal-sweep` is the step that closes it, and the split
  // between the two connectors is the thesis: the free, unauthenticated one
  // drives the shipped flow, and the keyed one is there for a mandate that
  // names an onchain venue.
  const bp = getCrewBlueprint("governance-desk")!;
  const byId = new Map(bp.connectors.map((c) => [c.id, c]));
  assert.equal(byId.get("snapshot")?.usedBy ?? "flow", "flow");
  assert.equal(byId.get("tally")?.usedBy, "operator");

  const sweep = getFlowTemplate("governance-proposal-sweep")!.definition;
  const tools = sweep.steps.flatMap((s) => (s.kind === "tool" ? [s.tool] : []));
  assert.ok(tools.includes("snapshot.query"), "the sweep must read the space it sweeps");

  // The one rule the flow rests on: the connector call is parameterised by the
  // run input and nothing else. A step that fed a completion back into the
  // query would be interpolating a model into GraphQL, and the queue would be
  // whatever it wrote.
  const queue = sweep.steps.find((s) => s.id === "queue")!;
  assert.equal(queue.kind, "tool");
  const query = String((queue as { args?: Record<string, unknown> }).args?.query ?? "");
  assert.match(query, /\{\{input\.space\}\}/);
  assert.ok(!/\{\{steps\./.test(query), "no step output may reach the query");

  // And it does not claim to have voted. Casting is a signed message the crew
  // cannot produce, so the sweep's terminal step is an instruction.
  assert.ok(!sweep.steps.some((s) => s.kind === "governance"));
  assert.ok(bp.outOfScope.some((line) => /casting the off-chain vote/i.test(line)));
});

test("the dev crew's connector note points at the credential the preset defaults to", () => {
  // The preset's default became a GitHub App installation; a note still naming
  // GH_TOKEN sends an operator to set a variable that mode never reads.
  const need = getCrewBlueprint("github-experts")!.connectors.find((c) => c.id === "github")!;
  for (const env of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"]) {
    assert.ok(need.note.includes(env), `the note should name ${env}`);
  }
});

test("the GitHub crew asks policy before it merges, and cannot merge otherwise", () => {
  const def = getFlowTemplate("bot-pr-triage")!.definition;
  const check = def.steps.find((s) => s.id === "merge-check");
  assert.equal(check?.kind === "tool" && check.tool, "lacrew_check_policy");
  // The merge step is reachable only from the branch that read the verdict.
  const reachesMerge = def.steps.filter((s) => JSON.stringify(stepEdges(s)).includes('"merge"'));
  assert.deepEqual(
    reachesMerge.map((s) => s.id),
    ["may-merge"],
  );
  const merge = def.steps.find((s) => s.id === "merge");
  assert.equal(merge?.kind === "tool" && merge.tool, "github.merge_pull_request");
});

test("the fixer asks policy before it pushes, and reads nothing if refused", () => {
  const def = getFlowTemplate("dep-fix-loop")!.definition;
  const check = def.steps.find((s) => s.id === "push-check");
  assert.equal(check?.kind === "tool" && check.tool, "lacrew_check_policy");
  // The push is reachable only from the branch that read the verdict, and so
  // are the reads: asking first is what makes a DENY cost nothing and touch
  // nothing, rather than refusing after two requests have already gone out.
  const reachesPush = def.steps.filter((s) => JSON.stringify(stepEdges(s)).includes('"push"'));
  assert.deepEqual(
    reachesPush.map((s) => s.id),
    ["build-commit"],
  );
  const reachesRead = def.steps.filter((s) =>
    JSON.stringify(stepEdges(s)).includes('"read-changed"'),
  );
  assert.deepEqual(
    reachesRead.map((s) => s.id),
    ["may-push"],
  );
  const push = def.steps.find((s) => s.id === "push");
  assert.equal(push?.kind === "tool" && push.tool, "github.update_ref");
});

test("the fix lands as one commit, whatever it touches", () => {
  const def = getFlowTemplate("dep-fix-loop")!.definition;
  const step = (id: string) => {
    const s = def.steps.find((x) => x.id === id);
    assert.ok(s?.kind === "tool", `${id} should be a tool step`);
    return s;
  };
  // Git's own object API in order: a tree off the branch's tree, one commit on
  // it, then the ref moves. Several files in, one commit and one CI run out.
  assert.equal(step("build-tree").tool, "github.create_tree");
  assert.equal(step("build-tree").args?.base_tree, "{{steps.read-base.json.body.tree.sha}}");
  assert.equal(step("build-tree").args?.tree, "{{steps.patch.text}}");
  assert.equal(step("build-commit").tool, "github.create_commit");
  assert.equal(step("build-commit").args?.tree, "{{steps.build-tree.json.body.sha}}");
  // The head the run read, so a branch that moved underneath makes this a
  // non-fast-forward that GitHub refuses rather than a silent clobber.
  assert.equal(step("build-commit").args?.parents, "{{steps.read-head.json.body.object.sha}}");
});

test("the push carries the branch it was given and the commit it built", () => {
  const push = getFlowTemplate("dep-fix-loop")!.definition.steps.find((s) => s.id === "push");
  assert.ok(push?.kind === "tool");
  assert.equal(push.args?.branch, "{{input.branch}}");
  assert.equal(push.args?.sha, "{{steps.build-commit.json.body.sha}}");
  // No field that could force, and none that could name a different repo.
  assert.deepEqual(Object.keys(push.args ?? {}).sort(), ["branch", "owner", "repo", "sha"]);
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

  const reachesGate = def.steps.filter((s) => JSON.stringify(stepEdges(s)).includes('"publish"'));
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
  assert.equal(
    crewPlan(getCrewBlueprint("github-experts")!).filter((s) => s.kind === "bind-policy").length,
    0,
  );
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
    assert.ok(
      !JSON.stringify(step.args).includes("{{"),
      `${step.summary} still carries a placeholder`,
    );
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
