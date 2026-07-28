import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getCrewBlueprint, crewBlueprints } from "./crewBlueprints.js";
import {
  BLUEPRINT_AGENT_LABEL,
  blueprintCrewLabel,
  caresForPrompt,
  deriveCrewDirectives,
  deriveCrewLayer,
  deriveRoleLayer,
  renderCrewGuidelines,
} from "./crewDirectives.js";

const github = getCrewBlueprint("github-experts")!;

describe("renderCrewGuidelines", () => {
  it("names the mechanism beside every rule, not just the rule", () => {
    const text = renderCrewGuidelines(github);
    assert.match(text, /Must never happen:/);
    // "Never merge to main" backed by a policy module and the same sentence
    // backed by nothing are different instructions. An agent that cannot tell
    // them apart treats a monitoring-only rail as though something stops it.
    for (const rail of github.guardrails) {
      assert.ok(text.includes(rail.never), `missing guardrail: ${rail.never}`);
      assert.ok(text.includes(`Enforced by ${rail.enforcedBy}`));
    }
  });

  it("carries what the crew deliberately does not do", () => {
    const text = renderCrewGuidelines(github);
    assert.match(text, /Not this crew's work:/);
    assert.ok(text.includes(github.outOfScope[0]!));
  });

  it("leads with the summary, so the crew is named before it is constrained", () => {
    assert.ok(renderCrewGuidelines(github).startsWith(github.summary));
  });
});

describe("deriveCrewDirectives", () => {
  it("gives every seat the crew's rules and then its own charter", () => {
    const seeded = deriveCrewDirectives(github);
    assert.equal(seeded.length, github.roles.length);

    const lead = seeded.find((s) => s.roleId === "review-lead")!;
    assert.deepEqual(
      lead.layers.map((l) => l.label),
      [blueprintCrewLabel("github-experts"), BLUEPRINT_AGENT_LABEL],
    );
    // Crew first, agent second — the specific qualifies the general, matching
    // how the orchestrator composes them.
    assert.equal(lead.layers[1]?.text, github.roles.find((r) => r.id === "review-lead")!.charter);
  });

  it("invents no skills and no resources — every field traces to the blueprint", () => {
    for (const seeded of deriveCrewDirectives(github)) {
      for (const layer of seeded.layers) {
        // A skill body synthesised from a flow id would be invention presented
        // as configuration, and nobody could tell it from what they wrote.
        assert.equal(layer.skills, undefined, `${seeded.roleId} got invented skills`);
        // A blueprint cannot know which repos belong to whoever installs it.
        assert.equal(layer.resources, undefined, `${seeded.roleId} got invented resources`);
      }
    }
  });

  it("covers every first-party blueprint without throwing", () => {
    for (const blueprint of crewBlueprints) {
      const seeded = deriveCrewDirectives(blueprint);
      assert.equal(seeded.length, blueprint.roles.length);
      for (const entry of seeded) {
        assert.ok(entry.layers.length > 0, `${blueprint.id}/${entry.roleId} seeded nothing`);
      }
    }
  });

  it("omits the crew layer rather than emitting an empty one", () => {
    const bare = { ...github, summary: "", guardrails: [], outOfScope: [] };
    assert.equal(deriveCrewLayer(bare), null);
    assert.deepEqual(
      deriveCrewDirectives(bare).map((s) => s.layers.map((l) => l.label)),
      github.roles.map(() => [BLUEPRINT_AGENT_LABEL]),
    );
  });

  it("omits a seat's own layer when it has no charter", () => {
    assert.equal(deriveRoleLayer({ ...github.roles[0]!, charter: "  " }), null);
  });
});

describe("caresForPrompt", () => {
  it("declares the noun each crew looks after, so the editor can prompt for it", () => {
    assert.equal(caresForPrompt(github)?.kind, "repo");
    assert.equal(caresForPrompt(getCrewBlueprint("defi-desk")!)?.kind, "venue");
    assert.equal(caresForPrompt(getCrewBlueprint("content-studio")!)?.kind, "account");
  });

  it("every first-party blueprint says what it looks after, with a usable hint", () => {
    for (const blueprint of crewBlueprints) {
      const prompt = caresForPrompt(blueprint);
      assert.ok(prompt, `${blueprint.id} declares no caresFor`);
      assert.ok(prompt!.hint.trim().length > 20, `${blueprint.id} hint is too thin to act on`);
    }
  });

  it("is null for a crew that looks after nothing external", () => {
    const { caresFor: _dropped, ...bare } = github;
    assert.equal(caresForPrompt(bare), null);
  });
});
