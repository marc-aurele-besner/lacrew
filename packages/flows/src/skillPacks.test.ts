import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeMissing,
  diffSkillPack,
  exportSkillPack,
  hasMissingRequirements,
  installSkillPack,
  installedSkillPacks,
  missingRequirements,
  parseSkillPack,
  removeSkillPack,
  skillPackScopeFits,
  validateSkillPack,
  type SkillPack,
} from "./skillPacks.js";
import { firstPartySkillPacks, getSkillPack } from "./skillPackLibrary.js";
import { crewFlowTemplates } from "./crewTemplates.js";
import type { BriefLayer } from "./crews.js";

const pack: SkillPack = {
  id: "demo-pack",
  version: "1.0.0",
  name: "Demo pack",
  summary: "Two procedures.",
  scope: "agent",
  skills: [
    { id: "first", name: "First", trigger: "When one.", body: "Do one." },
    { id: "second", name: "Second", trigger: "When two.", body: "Do two." },
  ],
};

/* ——— validation ——— */

test("a well-formed pack validates and normalizes", () => {
  const result = validateSkillPack({ ...pack, summary: "  Two procedures.  " });
  assert.equal(result.ok, true);
  assert.equal(result.pack?.summary, "Two procedures.");
  assert.equal(result.pack?.skills.length, 2);
});

test("a skill without a trigger is refused", () => {
  const result = validateSkillPack({
    ...pack,
    skills: [{ id: "first", name: "First", trigger: "   ", body: "Do one." }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("trigger is required")));
});

test("empty skills, bad ids and duplicates are all named", () => {
  assert.ok(validateSkillPack({ ...pack, skills: [] }).errors.includes("skills must not be empty"));

  const badId = validateSkillPack({ ...pack, id: "Demo Pack" });
  assert.equal(badId.ok, false);
  assert.ok(badId.errors.some((e) => e.includes("must be lowercase")));

  const dupe = validateSkillPack({
    ...pack,
    skills: [pack.skills[0]!, { ...pack.skills[0]!, name: "Again" }],
  });
  assert.equal(dupe.ok, false);
  assert.ok(dupe.errors.some((e) => e.includes("duplicated")));
});

test("a non-object, an oversized body and a bad requires shape are refused", () => {
  assert.equal(validateSkillPack(null).ok, false);
  assert.equal(validateSkillPack([]).ok, false);

  const big = validateSkillPack({
    ...pack,
    skills: [{ id: "first", name: "First", trigger: "When.", body: "x".repeat(5_000) }],
  });
  assert.ok(big.errors.some((e) => e.includes("body is too long")));

  const badRequires = validateSkillPack({ ...pack, requires: { flows: "bot-pr-triage" } });
  assert.ok(badRequires.errors.some((e) => e.includes("requires.flows must be an array")));
});

test("parseSkillPack reports a syntax error rather than throwing", () => {
  const result = parseSkillPack("{not json");
  assert.equal(result.ok, false);
  assert.ok(result.errors[0]?.includes("not valid JSON"));
  assert.equal(parseSkillPack(JSON.stringify(pack)).ok, true);
});

/* ——— requirements ——— */

test("missing requirements are listed per dimension, routes checked by name", () => {
  const needs: SkillPack = {
    ...pack,
    requires: {
      flows: ["bot-pr-triage"],
      connectors: ["github.merge_pull_request", "coingecko"],
      mcpTools: ["lacrew_check_policy"],
    },
  };
  const missing = missingRequirements(needs, {
    flows: ["bot-pr-triage"],
    connectors: ["github"],
    connectorTools: ["github.get_pull_request"],
    mcpTools: ["lacrew_check_policy"],
  });
  assert.deepEqual(missing.flows, []);
  assert.deepEqual(missing.connectors, ["github.merge_pull_request", "coingecko"]);
  assert.deepEqual(missing.mcpTools, []);
  assert.equal(hasMissingRequirements(missing), true);
  assert.ok(describeMissing(missing).includes("connectors: github.merge_pull_request"));
});

test("an unreadable registry counts as nothing registered, not as nothing required", () => {
  const needs: SkillPack = { ...pack, requires: { connectors: ["github"] } };
  assert.deepEqual(missingRequirements(needs, {}).connectors, ["github"]);
  assert.equal(hasMissingRequirements(missingRequirements(pack, {})), false);
});

/* ——— install / update / uninstall ——— */

test("install lands on the agent layer and leaves hand-written skills alone", () => {
  const layers: BriefLayer[] = [
    {
      label: "agent",
      text: "House rules.",
      skills: [{ name: "Mine", when: "When I say.", instructions: "As written." }],
    },
  ];
  const result = installSkillPack(layers, pack);
  assert.equal(result.label, "agent");
  assert.equal(result.installed, 2);
  assert.equal(result.replaced, 0);

  const skills = result.layers[0]!.skills!;
  assert.deepEqual(
    skills.map((s) => s.name),
    ["Mine", "First", "Second"],
  );
  assert.equal(skills[0]!.source, undefined);
  assert.deepEqual(skills[1]!.source, { pack: "demo-pack", version: "1.0.0", skill: "first" });
  assert.equal(result.layers[0]!.text, "House rules.");
});

test("install creates the layer when the directive has none", () => {
  const result = installSkillPack([], pack);
  assert.equal(result.layers.length, 1);
  assert.equal(result.layers[0]!.label, "agent");
  assert.equal(result.layers[0]!.skills!.length, 2);
});

test("installing twice is idempotent and keeps the pack's slot on update", () => {
  const once = installSkillPack(
    [{ label: "agent", skills: [{ name: "Mine", when: "When.", instructions: "As written." }] }],
    pack,
  );
  const twice = installSkillPack(once.layers, pack);
  assert.equal(twice.layers[0]!.skills!.length, 3);
  assert.equal(twice.replaced, 2);

  const v2: SkillPack = {
    ...pack,
    version: "2.0.0",
    skills: [
      { id: "first", name: "First", trigger: "When one, revised.", body: "Do one, better." },
    ],
  };
  const updated = installSkillPack(twice.layers, v2);
  const names = updated.layers[0]!.skills!.map((s) => s.name);
  // The pack's slot is where it already was, not appended after the
  // hand-written skill it used to precede.
  assert.deepEqual(names, ["Mine", "First"]);
  assert.equal(updated.layers[0]!.skills![1]!.instructions, "Do one, better.");
  assert.equal(updated.replaced, 2);
  assert.deepEqual(installedSkillPacks(updated.layers), [
    { pack: "demo-pack", version: "2.0.0", label: "agent", skills: 1, skillIds: ["first"] },
  ]);
});

test("installing onto a second layer moves the pack rather than duplicating it", () => {
  const first = installSkillPack([], { ...pack, scope: "either" });
  const second = installSkillPack(
    first.layers,
    { ...pack, scope: "either" },
    { label: "crew:desk" },
  );
  const installed = installedSkillPacks(second.layers);
  assert.equal(installed.length, 1);
  assert.equal(installed[0]!.label, "crew:desk");
  // The emptied agent layer keeps its identity but carries no orphan skills.
  const agent = second.layers.find((l) => l.label === "agent");
  assert.equal(agent?.skills, undefined);
});

test("scope decides which layer a pack may land on", () => {
  assert.equal(skillPackScopeFits(pack, "crew:desk"), false);
  assert.equal(skillPackScopeFits({ ...pack, scope: "crew" }, "agent"), false);
  assert.equal(skillPackScopeFits({ ...pack, scope: "either" }, "crew:desk"), true);
  assert.throws(() => installSkillPack([], pack, { label: "crew:desk" }), /scope_mismatch/);
  assert.throws(() => installSkillPack([], { ...pack, scope: "crew" }), /label_required/);
});

test("uninstall removes only the pack's skills, in every layer", () => {
  const installed = installSkillPack(
    [{ label: "agent", skills: [{ name: "Mine", when: "When.", instructions: "As written." }] }],
    pack,
  );
  const other = installSkillPack(installed.layers, { ...pack, id: "second-pack" });
  const removed = removeSkillPack(other.layers, "demo-pack");
  assert.equal(removed.removed, 2);
  assert.deepEqual(
    removed.layers[0]!.skills!.map((s) => s.name),
    ["Mine", "First", "Second"],
  );
  assert.deepEqual(
    installedSkillPacks(removed.layers).map((p) => p.pack),
    ["second-pack"],
  );
  assert.equal(removeSkillPack(removed.layers, "demo-pack").removed, 0);
});

/* ——— export ——— */

test("export round-trips a directive's skills back into a valid pack", () => {
  const layers = installSkillPack(
    [
      {
        label: "agent",
        skills: [{ name: "Mine", when: "When I say.", instructions: "As written." }],
      },
    ],
    pack,
  ).layers;
  const exported = exportSkillPack(layers, { id: "backup", version: "1.0.0", name: "Backup" });
  assert.equal(validateSkillPack(exported).ok, true);
  assert.deepEqual(
    exported.skills.map((s) => s.id),
    ["mine", "first", "second"],
  );
});

test("export names a missing trigger instead of dropping the skill", () => {
  const exported = exportSkillPack(
    [{ label: "agent", skills: [{ name: "Mine", instructions: "As written." }] }],
    {
      id: "backup",
      version: "1.0.0",
      name: "Backup",
    },
  );
  assert.ok(exported.skills[0]!.trigger.startsWith("TODO"));
});

/* ——— diff before an update ——— */

const packV2: SkillPack = {
  ...pack,
  version: "2.0.0",
  skills: [
    { id: "first", name: "First", trigger: "When one.", body: "Do one, carefully." },
    { id: "third", name: "Third", trigger: "When three.", body: "Do three." },
  ],
};

test("a diff against a directive that has never seen the pack is all additions", () => {
  const diff = diffSkillPack([{ label: "agent", text: "House rules." }], pack);
  assert.equal(diff.from, null);
  assert.equal(diff.added, 2);
  assert.equal(diff.changed + diff.removed + diff.unchanged, 0);
});

test("a diff names what changed, what is new, and what would disappear", () => {
  const layers = installSkillPack([{ label: "agent" }], pack).layers;
  const diff = diffSkillPack(layers, packV2);
  assert.equal(diff.from, "1.0.0");
  assert.equal(diff.to, "2.0.0");
  assert.deepEqual(
    diff.entries.map((e) => [e.skill, e.status]),
    [
      ["first", "changed"],
      ["third", "added"],
      ["second", "removed"],
    ],
  );
  assert.deepEqual(diff.entries[0]!.fields, ["body"]);
});

test("a diff matches on the skill id, so a rename is not a replacement", () => {
  const layers = installSkillPack([{ label: "agent" }], pack).layers;
  const renamed: SkillPack = {
    ...pack,
    version: "1.1.0",
    skills: [
      { id: "first", name: "First, renamed", trigger: "When one.", body: "Do one." },
      pack.skills[1]!,
    ],
  };
  const diff = diffSkillPack(layers, renamed);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  assert.deepEqual(diff.entries[0]!.fields, ["name"]);
  assert.equal(diff.entries[1]!.status, "unchanged");
});

test("a diff ignores hand-written skills, whatever they are called", () => {
  const layers = installSkillPack(
    [{ label: "agent", skills: [{ name: "First", when: "Mine.", instructions: "Mine." }] }],
    pack,
  ).layers;
  const diff = diffSkillPack(layers, pack);
  assert.equal(diff.entries.length, 2);
  assert.equal(diff.added + diff.changed + diff.removed, 0);
});

/* ——— the packs that ship ——— */

test("every first-party pack validates", () => {
  for (const shipped of firstPartySkillPacks) {
    const result = validateSkillPack(shipped);
    assert.equal(result.ok, true, `${shipped.id}: ${result.errors.join("; ")}`);
  }
  assert.equal(getSkillPack("github-pr-triage")?.name, "GitHub PR triage");
  assert.equal(getSkillPack("nope"), undefined);
});

test("first-party packs require only flows that ship", () => {
  const shippedFlows = new Set(crewFlowTemplates.map((t) => t.definition.id));
  for (const shipped of firstPartySkillPacks) {
    for (const flowId of shipped.requires?.flows ?? []) {
      assert.ok(shippedFlows.has(flowId), `${shipped.id} requires unknown flow ${flowId}`);
    }
  }
});

test("first-party packs name only routes their required flows actually call", () => {
  const byId = new Map(crewFlowTemplates.map((t) => [t.definition.id, t.definition]));
  for (const shipped of firstPartySkillPacks) {
    const called = new Set<string>();
    for (const flowId of shipped.requires?.flows ?? []) {
      for (const step of byId.get(flowId)?.steps ?? []) {
        if (step.kind === "tool" && step.tool) called.add(step.tool);
      }
    }
    for (const ref of shipped.requires?.connectors ?? []) {
      if (!ref.includes(".")) continue;
      assert.ok(called.has(ref), `${shipped.id} requires ${ref}, which none of its flows call`);
    }
  }
});
