import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSkills } from "./skills.js";

const AGENT = "0x00000000000000000000000000000000000000a1";

async function capture(args: string[]): Promise<{ out: string; error?: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  try {
    await cmdSkills(args);
    return { out: out.join("\n") };
  } catch (err) {
    return { out: out.join("\n"), error: err instanceof Error ? err.message : String(err) };
  } finally {
    console.log = log;
  }
}

/** The orchestrator as a stubbed `fetch`; what is checked is the CLI's half. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    calls.push({
      url: path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const route = key ? routes[key]! : { status: 404, body: { error: "not_found" } };
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe("lacrew skills, offline", () => {
  it("lists the packs that ship", async () => {
    const { out } = await capture(["list"]);
    assert.match(out, /github-pr-triage\s+—\s+GitHub PR triage/);
    assert.match(out, /skills · scope agent/);
  });

  it("shows a pack's triggers and what it requires", async () => {
    const { out } = await capture(["show", "github-pr-triage"]);
    assert.match(out, /Flows\s+bot-pr-triage, dep-fix-loop, merge-window-digest/);
    assert.match(out, /Connectors\s+github\.get_pull_request, github\.merge_pull_request/);
    assert.match(out, /Use when: A pull request from a dependency bot/);
  });

  it("names the known packs when asked for one that does not ship", async () => {
    const { error } = await capture(["show", "nope"]);
    assert.match(error ?? "", /Unknown pack "nope"\. Ships: github-pr-triage/);
  });

  it("refuses a file that is not a valid pack, listing why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lacrew-skills-"));
    const path = join(dir, "pack.json");
    writeFileSync(
      path,
      JSON.stringify({
        id: "local",
        version: "1.0.0",
        name: "Local",
        skills: [{ id: "one", name: "One", body: "Do it." }],
      }),
    );
    const { error } = await capture(["show", "--file", path]);
    assert.match(error ?? "", /is not a valid skill pack/);
    assert.match(error ?? "", /trigger is required/);
  });
});

describe("lacrew skills, against an orchestrator", () => {
  it("lists what this deployment is missing, per dimension", async () => {
    const stub = stubFetch({
      "/skills/packs": {
        body: {
          packs: [
            {
              id: "github-pr-triage",
              version: "1.0.0",
              name: "GitHub PR triage",
              summary: "Triage.",
              installable: false,
              missing: {
                flows: ["dep-fix-loop"],
                connectors: ["github.merge_pull_request"],
                mcpTools: [],
              },
            },
          ],
        },
      },
    });
    try {
      const { out } = await capture(["list", "--url", "http://orch.test"]);
      assert.match(out, /✗ github-pr-triage/);
      assert.match(out, /missing flows: dep-fix-loop/);
      assert.match(out, /missing connectors: github\.merge_pull_request/);
    } finally {
      stub.restore();
    }
  });

  it("posts the pack itself, not just its id, and reports what landed", async () => {
    const stub = stubFetch({
      "/agents/skills/install": {
        body: {
          pack: "github-pr-triage",
          version: "1.0.0",
          label: "agent",
          installed: 3,
          replaced: 0,
        },
      },
    });
    try {
      const { out } = await capture([
        "install",
        "github-pr-triage",
        "--agent",
        AGENT,
        "--url",
        "http://orch.test",
      ]);
      const sent = stub.calls[0]!.body as {
        agent: string;
        pack: { id: string; skills: unknown[] };
      };
      assert.equal(stub.calls[0]!.url, "/agents/skills/install");
      assert.equal(sent.agent, AGENT);
      assert.equal(sent.pack.id, "github-pr-triage");
      assert.equal(sent.pack.skills.length, 3);
      assert.match(out, /Installed github-pr-triage 1\.0\.0/);
      assert.match(out, /instruction, not authority/);
    } finally {
      stub.restore();
    }
  });

  it("surfaces an unmet requirement as the orchestrator's own refusal", async () => {
    const stub = stubFetch({
      "/agents/skills/install": {
        status: 409,
        body: {
          error: "skill_pack_requirements_unmet (github-pr-triage) — missing connectors: github",
          missing: { flows: [], connectors: ["github"], mcpTools: [] },
        },
      },
    });
    try {
      const { error } = await capture([
        "install",
        "github-pr-triage",
        "--agent",
        AGENT,
        "--url",
        "http://orch.test",
      ]);
      assert.match(error ?? "", /requirements_unmet/);
      assert.match(error ?? "", /missing connectors: github/);
    } finally {
      stub.restore();
    }
  });

  it("says plainly when a removal changed nothing", async () => {
    const stub = stubFetch({ "/agents/skills/remove": { body: { removed: 0 } } });
    try {
      const { out } = await capture([
        "remove",
        "desk-notes",
        "--agent",
        AGENT,
        "--url",
        "http://orch.test",
      ]);
      assert.match(out, /was not installed .* Nothing changed/);
    } finally {
      stub.restore();
    }
  });

  it("exports a seat's skills as a pack that validates", async () => {
    const stub = stubFetch({
      "/agents/skills": {
        body: {
          brief: {
            layers: [
              {
                label: "agent",
                skills: [{ name: "Mine", when: "When I say.", instructions: "As written." }],
              },
            ],
          },
        },
      },
    });
    try {
      const { out } = await capture([
        "export",
        "--agent",
        AGENT,
        "--id",
        "my-pack",
        "--url",
        "http://orch.test",
      ]);
      const pack = JSON.parse(out) as {
        id: string;
        skills: Array<{ id: string; trigger: string }>;
      };
      assert.equal(pack.id, "my-pack");
      assert.deepEqual(pack.skills[0], {
        id: "mine",
        name: "Mine",
        trigger: "When I say.",
        body: "As written.",
      });
    } finally {
      stub.restore();
    }
  });

  it("refuses an export from a seat with no skills rather than writing an empty pack", async () => {
    const stub = stubFetch({ "/agents/skills": { body: { brief: null } } });
    try {
      const { error } = await capture([
        "export",
        "--agent",
        AGENT,
        "--id",
        "my-pack",
        "--url",
        "http://orch.test",
      ]);
      assert.match(error ?? "", /no skills to export/);
    } finally {
      stub.restore();
    }
  });

  it("refuses every write path without an agent", async () => {
    for (const args of [
      ["install", "github-pr-triage"],
      ["remove", "x"],
      ["installed"],
      ["export", "--id", "p"],
    ]) {
      const { error } = await capture(args);
      assert.match(error ?? "", /--agent/);
    }
  });
});
