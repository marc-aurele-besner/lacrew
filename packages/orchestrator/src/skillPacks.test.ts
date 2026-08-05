import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { createOrchestratorApp } from "./httpApp.js";
import { buildConnectorPreset, createConnectorRegistry } from "./index.js";
import { AgentControls, BRIEF_MAX_CHARS, type AgentControlRecord } from "./agentControls.js";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { crewFlowTemplates, getSkillPack, type SkillPack } from "@lacrew/flows";

const AGENT = "0x00000000000000000000000000000000000000a1";
const MERGE_AUTHORITY = "0x00000000000000000000000000000000000000aa";
const COMMENT_AUTHORITY = "0x00000000000000000000000000000000000000bb";
const PUSH_AUTHORITY = "0x00000000000000000000000000000000000000cc";

/**
 * An app with a knob for each thing a pack's `requires` is checked against:
 * which GitHub routes are registered, and which flows are saved.
 */
async function buildApp(
  opts: {
    github?: "none" | "read" | "full";
    flows?: string[];
    /** Whether the GitHub connector's credential is actually set. */
    credential?: boolean;
  } = {},
) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const model = new MemoryModelProvider();
  const flows = createFlowsSurface({ runtime, model });

  const github = opts.github ?? "none";
  const connectors =
    github === "none"
      ? undefined
      : createConnectorRegistry({
          connectors: [
            buildConnectorPreset("github", {
              authMode: "token",
              ...(github === "read"
                ? { omitRoutes: [
          "merge_pull_request",
          "create_issue_comment",
          "update_file",
          "create_tree",
          "create_commit",
          "update_ref",
        ] }
                : {
                    policyTargets: {
                      merge_pull_request: MERGE_AUTHORITY,
                      create_issue_comment: COMMENT_AUTHORITY,
                      push_authority: PUSH_AUTHORITY,
                    },
                    branches: ["dependabot/**"],
                  }),
            }),
          ],
          env: opts.credential === false ? {} : { GH_TOKEN: "ghp_test" },
        });

  for (const id of opts.flows ?? []) {
    const template = crewFlowTemplates.find((t) => t.definition.id === id);
    assert.ok(template, `no shipped template for ${id}`);
    await flows.save(template.definition);
  }

  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows,
    ...(connectors ? { connectors } : {}),
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { app, runtime, flows };
}

const GITHUB_FLOWS = ["bot-pr-triage", "dep-fix-loop", "merge-window-digest"];

/** A pack with no requirements, for the paths that are about the merge. */
const plain: SkillPack = {
  id: "desk-notes",
  version: "1.0.0",
  name: "Desk notes",
  summary: "One procedure.",
  scope: "agent",
  skills: [
    {
      id: "write-the-note",
      name: "Write the handover note",
      trigger: "The desk is closing and something is unresolved.",
      body: "Name what is unresolved, who is waiting, and the smallest thing that would unblock it.",
    },
  ],
};

async function install(app: Awaited<ReturnType<typeof buildApp>>["app"], body: unknown) {
  return app.request("/agents/skills/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("skill packs (F2.23)", () => {
  it("lists the shipped packs with what this deployment is missing", async () => {
    const { app } = await buildApp();
    const res = await app.request("/skills/packs");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      packs: Array<{
        id: string;
        installable: boolean;
        missing: { flows: string[]; connectors: string[] };
        skills: Array<{ id: string; trigger: string; body: string }>;
      }>;
    };
    const pack = body.packs.find((p) => p.id === "github-pr-triage")!;
    assert.equal(pack.installable, false);
    assert.deepEqual(pack.missing.flows, GITHUB_FLOWS);
    assert.deepEqual(pack.missing.connectors, [
      "github.get_pull_request",
      "github.merge_pull_request",
    ]);
    // The trigger is part of the listing: it is what an operator reads to
    // decide whether a skill belongs on this seat. So is the body — a catalog
    // that showed only triggers would ask an operator to approve instruction
    // reaching a model's prompt without letting them read it first.
    assert.ok(pack.skills.every((s) => s.trigger.length > 0 && s.body.length > 0));
  });

  it("refuses a connector that is registered but has no credential", async () => {
    // The failure this catches is the one a status page hides: the connector is
    // there, so the pack reads installable, and every call the procedure makes
    // fails on an unset token. Registered is not the same as usable.
    const unset = await buildApp({ github: "full", credential: false, flows: GITHUB_FLOWS });
    const refused = await install(unset.app, { agent: AGENT, packId: "github-pr-triage" });
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { missing: { connectors: string[] } };
    assert.deepEqual(body.missing.connectors, [
      "github.get_pull_request",
      "github.merge_pull_request",
    ]);
    assert.equal(unset.runtime.agentBrief(AGENT), null);

    // The same deployment with the token set takes it.
    const set = await buildApp({ github: "full", flows: GITHUB_FLOWS });
    assert.equal(
      (await install(set.app, { agent: AGENT, packId: "github-pr-triage" })).status,
      200,
    );
  });

  it("refuses an install whose connector is not registered, and takes it once it is", async () => {
    const unwired = await buildApp({ flows: GITHUB_FLOWS });
    const refused = await install(unwired.app, { agent: AGENT, packId: "github-pr-triage" });
    assert.equal(refused.status, 409);
    const refusedBody = (await refused.json()) as {
      error: string;
      missing: { connectors: string[] };
    };
    assert.deepEqual(refusedBody.missing.connectors, [
      "github.get_pull_request",
      "github.merge_pull_request",
    ]);
    // Nothing was written: a refused install must not leave half a directive.
    assert.equal(unwired.runtime.agentBrief(AGENT), null);

    const wired = await buildApp({ github: "full", flows: GITHUB_FLOWS });
    const ok = await install(wired.app, { agent: AGENT, packId: "github-pr-triage" });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { installed: number; label: string; systemPrompt: string };
    assert.equal(body.label, "agent");
    assert.equal(body.installed, getSkillPack("github-pr-triage")!.skills.length);
    // The prompt carries the trigger and the body — the whole point of an
    // install is that the model reads them.
    assert.ok(body.systemPrompt.includes("Use when: A pull request from a dependency bot"));
    assert.ok(body.systemPrompt.includes("bot-pr-triage"));
  });

  it("refuses when the connector is registered with reads only", async () => {
    const { app } = await buildApp({ github: "read", flows: GITHUB_FLOWS });
    const res = await install(app, { agent: AGENT, packId: "github-pr-triage" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { missing: { connectors: string[] } };
    assert.deepEqual(body.missing.connectors, ["github.merge_pull_request"]);
  });

  it("refuses when a required flow is not saved here", async () => {
    const { app } = await buildApp({ github: "full", flows: ["bot-pr-triage"] });
    const res = await install(app, { agent: AGENT, packId: "github-pr-triage" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { missing: { flows: string[] } };
    assert.deepEqual(body.missing.flows, ["dep-fix-loop", "merge-window-digest"]);
  });

  it("refuses an inline pack whose skill has no trigger", async () => {
    const { app } = await buildApp();
    const res = await install(app, {
      agent: AGENT,
      pack: { ...plain, skills: [{ ...plain.skills[0]!, trigger: "" }] },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; errors: string[] };
    assert.equal(body.error, "invalid_skill_pack");
    assert.ok(body.errors.some((e) => e.includes("trigger is required")));
  });

  it("answers 404 for a pack that does not ship, and 400 with no pack at all", async () => {
    const { app } = await buildApp();
    assert.equal((await install(app, { agent: AGENT, packId: "nope" })).status, 404);
    assert.equal((await install(app, { agent: AGENT })).status, 400);
    assert.equal((await install(app, { packId: "github-pr-triage" })).status, 400);
  });

  it("refuses a pack that would blow the directive ceiling, naming it", async () => {
    const { app } = await buildApp();
    const huge: SkillPack = {
      ...plain,
      id: "huge-pack",
      skills: Array.from({ length: 6 }, (_, i) => ({
        id: `bulk-${i}`,
        name: `Bulk ${i}`,
        trigger: "When the directive has room, which it does not.",
        body: "x".repeat(2_000),
      })),
    };
    const res = await install(app, { agent: AGENT, pack: huge });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error: string; pack: string; chars: number };
    assert.equal(body.pack, "huge-pack");
    assert.ok(body.chars > BRIEF_MAX_CHARS);
    assert.ok(body.error.includes("huge-pack"));
    assert.ok(body.error.includes("Remove an installed pack"));
  });

  it("keeps hand-written skills through install, update and uninstall", async () => {
    const { app, runtime } = await buildApp();
    const brief = await app.request("/agents/brief", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: AGENT,
        layers: [
          {
            label: "agent",
            text: "House rules.",
            skills: [{ name: "Mine", when: "When I say so.", instructions: "As written." }],
          },
        ],
      }),
    });
    assert.equal(brief.status, 200);

    const installed = await install(app, { agent: AGENT, pack: plain });
    assert.equal(installed.status, 200);

    const updated = await install(app, {
      agent: AGENT,
      pack: {
        ...plain,
        version: "2.0.0",
        skills: [{ ...plain.skills[0]!, body: "Say it in one line." }],
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as { replaced: number }).replaced, 1);

    const listed = await app.request(`/agents/skills?agent=${AGENT}`);
    const listedBody = (await listed.json()) as {
      packs: Array<{ pack: string; version: string; skills: number }>;
    };
    assert.deepEqual(listedBody.packs, [
      {
        pack: "desk-notes",
        version: "2.0.0",
        label: "agent",
        skills: 1,
        skillIds: ["write-the-note"],
      },
    ]);

    const removed = await app.request("/agents/skills/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: AGENT, packId: "desk-notes" }),
    });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { removed: number }).removed, 1);

    const layers = runtime.agentBrief(AGENT)!.layers;
    assert.deepEqual(
      layers[0]!.skills!.map((s) => s.name),
      ["Mine"],
    );
    assert.equal(layers[0]!.text, "House rules.");
  });

  it("records the install and the removal in the trail, without the bodies", async () => {
    const { app, runtime } = await buildApp();
    await install(app, { agent: AGENT, pack: plain });
    await app.request("/agents/skills/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: AGENT, packId: "desk-notes" }),
    });
    const events = (await runtime.audit()).filter((e) => e.type.startsWith("SkillPack"));
    // The ring reads newest-first.
    assert.deepEqual(
      events.map((e) => e.type),
      ["SkillPackRemoved", "SkillPackInstalled"],
    );
    const payload = events[1]!.payload as Record<string, unknown>;
    assert.equal(payload.pack, "desk-notes");
    assert.equal(payload.version, "1.0.0");
    assert.equal(payload.skills, 1);
    assert.ok(!JSON.stringify(payload).includes("who is waiting"));
  });

  it("PUT /agents/brief round-trips resources and skills rather than dropping them", async () => {
    const { app, runtime } = await buildApp();
    await install(app, { agent: AGENT, pack: plain });
    const layers = runtime.agentBrief(AGENT)!.layers;

    // What a directive editor does: read the brief, add a line, write it back.
    const res = await app.request("/agents/brief", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: AGENT,
        layers: [
          {
            ...layers[0],
            text: "Now with guidelines.",
            resources: [{ kind: "repo", ref: "owner/repo" }],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);

    const after = runtime.agentBrief(AGENT)!.layers[0]!;
    assert.equal(after.resources?.[0]?.ref, "owner/repo");
    assert.equal(after.skills?.length, 1);
    // Provenance survives the round trip, so the pack is still uninstallable.
    assert.deepEqual(after.skills![0]!.source, {
      pack: "desk-notes",
      version: "1.0.0",
      skill: "write-the-note",
    });
  });

  it("an installed pack survives a restart", async () => {
    const saved: AgentControlRecord[] = [];
    const store = {
      loadAgentControls: async () => saved,
      saveAgentControl: async (record: AgentControlRecord) => {
        const at = saved.findIndex((r) => r.agent === record.agent);
        if (at >= 0) saved[at] = record;
        else saved.push(record);
      },
    };

    const before = new AgentControls(store);
    before.setBrief(
      AGENT,
      [
        {
          label: "agent",
          skills: [
            {
              name: "Write the handover note",
              when: "The desk is closing and something is unresolved.",
              instructions: "Name what is unresolved.",
              source: { pack: "desk-notes", version: "1.0.0", skill: "write-the-note" },
            },
          ],
        },
      ],
      new Date().toISOString(),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const after = new AgentControls(store);
    const hydrated = await after.hydrate();
    assert.equal(hydrated.ok, true);
    assert.deepEqual(after.briefFor(AGENT)!.layers[0]!.skills![0]!.source, {
      pack: "desk-notes",
      version: "1.0.0",
      skill: "write-the-note",
    });
    assert.ok(after.systemPromptFor(AGENT).includes("Use when: The desk is closing"));
  });
});
