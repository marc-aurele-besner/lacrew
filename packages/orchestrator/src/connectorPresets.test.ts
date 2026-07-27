import { strict as assert } from "node:assert";
import { test } from "node:test";
import { crewBlueprints } from "@lacrew/flows";
import {
  buildConnectorPreset,
  connectorPresets,
  getConnectorPreset,
  presetPolicyTargetRoutes,
  resolveConnectorConfig,
} from "./connectorPresets.js";
import { createConnectorRegistry, loadConnectorsFromEnv, validateConnector } from "./connectors.js";

const MERGE_AUTHORITY = "0x00000000000000000000000000000000000000aa" as const;

test("every shipped preset builds into a connector the registry accepts", () => {
  for (const preset of connectorPresets) {
    const policyTargets = Object.fromEntries(
      presetPolicyTargetRoutes(preset).map((name) => [name, MERGE_AUTHORITY]),
    );
    const connector = buildConnectorPreset(preset.id, { policyTargets });
    assert.deepEqual(
      validateConnector(connector),
      [],
      `${preset.id} must validate: ${validateConnector(connector).join("; ")}`,
    );
  }
});

test("the github preset serves the routes the github-experts blueprint declares", () => {
  const connector = buildConnectorPreset("github", {
    policyTargets: { merge_pull_request: MERGE_AUTHORITY },
  });
  const names = connector.routes.map((r) => r.name);
  // The two the shipped `bot-pr-triage` flow actually calls. If these drift,
  // the crew's tools resolve to nothing at run time.
  assert.ok(names.includes("get_pull_request"));
  assert.ok(names.includes("merge_pull_request"));
  assert.equal(connector.baseUrl, "https://api.github.com");
  assert.deepEqual(connector.auth, { kind: "bearer", tokenEnv: "GH_TOKEN" });

  const merge = connector.routes.find((r) => r.name === "merge_pull_request")!;
  assert.equal(merge.method, "PUT");
  assert.equal(merge.path, "/repos/{owner}/{repo}/pulls/{number}/merge");
  assert.equal(merge.effect, "write");
  assert.equal(merge.policyTarget, MERGE_AUTHORITY);
});

test("only the merge route is a write — a preset does not widen what a token can do", () => {
  const connector = buildConnectorPreset("github", {
    policyTargets: { merge_pull_request: MERGE_AUTHORITY },
  });
  assert.deepEqual(
    connector.routes.filter((r) => r.effect === "write").map((r) => r.name),
    ["merge_pull_request"],
  );
});

test("a write with no policy target is refused rather than registered unadmitted", () => {
  assert.throws(
    () => buildConnectorPreset("github"),
    /connector_preset_unbound_policy_target:github\.merge_pull_request/,
  );
});

test("omitting the write builds a read-only connector without any binding", () => {
  const connector = buildConnectorPreset("github", { omitRoutes: ["merge_pull_request"] });
  assert.ok(connector.routes.every((r) => r.effect === "read"));
  assert.ok(!connector.routes.some((r) => r.name === "merge_pull_request"));
  assert.deepEqual(validateConnector(connector), []);
});

test("a misspelled route name is an error, not a silently ignored option", () => {
  assert.throws(
    () => buildConnectorPreset("github", { omitRoutes: ["merge_pr"] }),
    /connector_preset_unknown_route:github\.merge_pr/,
  );
  assert.throws(
    () => buildConnectorPreset("github", { policyTargets: { merge_pr: MERGE_AUTHORITY } }),
    /connector_preset_unknown_route:github\.merge_pr/,
  );
});

test("binding a policy target onto a read is refused", () => {
  assert.throws(
    () =>
      buildConnectorPreset("github", {
        policyTargets: { get_pull_request: MERGE_AUTHORITY, merge_pull_request: MERGE_AUTHORITY },
      }),
    /connector_preset_route_takes_no_policy_target:github\.get_pull_request/,
  );
});

test("a preset serves every route the blueprints declaring it call", () => {
  // The gap this module closes: a blueprint named `github.*` tools that no
  // shipped definition served. This asserts the pairing rather than trusting it
  // — a blueprint that adds a route now fails here instead of at run time.
  const needs = crewBlueprints.flatMap((bp) =>
    bp.connectors.map((need) => ({ blueprint: bp.id, need })),
  );
  const covered = needs.filter(({ need }) => getConnectorPreset(need.id));
  assert.ok(covered.length > 0, "no blueprint connector need is served by a preset");
  for (const { blueprint, need } of covered) {
    const served = new Set(getConnectorPreset(need.id)!.routes.map((r) => r.name));
    for (const route of need.routes) {
      assert.ok(
        served.has(route),
        `preset "${need.id}" does not serve ${need.id}.${route}, which "${blueprint}" calls`,
      );
    }
  }
});

test("an unknown preset names what does exist", () => {
  assert.throws(() => buildConnectorPreset("gitlab"), /unknown_connector_preset:gitlab/);
  assert.equal(getConnectorPreset("gitlab"), undefined);
});

test("overrides cover a self-hosted instance and a renamed credential", () => {
  const connector = buildConnectorPreset("github", {
    id: "ghe",
    baseUrl: "https://github.acme.example/api/v3",
    tokenEnv: "GHE_TOKEN",
    timeoutMs: 5_000,
    policyTargets: { merge_pull_request: MERGE_AUTHORITY },
  });
  assert.equal(connector.id, "ghe");
  assert.equal(connector.baseUrl, "https://github.acme.example/api/v3");
  assert.deepEqual(connector.auth, { kind: "bearer", tokenEnv: "GHE_TOKEN" });
  assert.equal(connector.timeoutMs, 5_000);
  assert.deepEqual(validateConnector(connector), []);
});

test("omitting every route is an error rather than an empty connector", () => {
  const all = getConnectorPreset("github")!.routes.map((r) => r.name);
  assert.throws(
    () => buildConnectorPreset("github", { omitRoutes: all }),
    /connector_preset_all_routes_omitted:github/,
  );
});

test("LACREW_CONNECTORS accepts a preset reference alongside a hand-written one", () => {
  const connectors = loadConnectorsFromEnv({
    LACREW_CONNECTORS: JSON.stringify([
      { preset: "github", policyTargets: { merge_pull_request: MERGE_AUTHORITY } },
      {
        id: "cms",
        baseUrl: "https://cms.example",
        auth: { kind: "bearer", tokenEnv: "CMS_TOKEN" },
        routes: [{ name: "get_post", method: "GET", path: "/posts/{id}", effect: "read" }],
      },
    ]),
  });
  assert.deepEqual(
    connectors.map((c) => c.id),
    ["github", "cms"],
  );
  const registry = createConnectorRegistry({ connectors, env: { GH_TOKEN: "x", CMS_TOKEN: "y" } });
  assert.ok(registry.handles("github.get_pull_request"));
  assert.ok(registry.handles("github.merge_pull_request"));
  assert.ok(registry.handles("cms.get_post"));
});

test("a preset reference with an unbound write stops the load, not the first run", () => {
  assert.throws(
    () => loadConnectorsFromEnv({ LACREW_CONNECTORS: JSON.stringify([{ preset: "github" }]) }),
    /connector_preset_unbound_policy_target/,
  );
});

test("resolveConnectorConfig passes a full definition through untouched", () => {
  const written = {
    id: "cms",
    baseUrl: "https://cms.example",
    auth: { kind: "none" as const },
    routes: [{ name: "get_post", method: "GET" as const, path: "/posts/{id}", effect: "read" as const }],
  };
  assert.deepEqual(resolveConnectorConfig([written]), [written]);
});

test("a preset route calls the URL the preset wrote down", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ number: 94 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const registry = createConnectorRegistry({
    connectors: [buildConnectorPreset("github", { omitRoutes: ["merge_pull_request"] })],
    env: { GH_TOKEN: "ghp_secret" },
    fetchImpl,
  });
  const res = await registry.call("github.get_pull_request", {
    owner: "marc-aurele-besner",
    repo: "lacrew",
    number: 94,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ["https://api.github.com/repos/marc-aurele-besner/lacrew/pulls/94"]);
});
