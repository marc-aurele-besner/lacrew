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
const COMMENT_AUTHORITY = "0x00000000000000000000000000000000000000bb" as const;

/** Both of the github preset's writes bound, which is what building it takes. */
const GITHUB_TARGETS = {
  merge_pull_request: MERGE_AUTHORITY,
  create_issue_comment: COMMENT_AUTHORITY,
} as const;

/** A stand-in host for the presets that ship none, because the site is the operator's. */
const OWN_HOST = "https://blog.example/ghost/api/admin";

/** Everything a preset refuses to guess, filled in so the build can be exercised. */
function bindings(preset: (typeof connectorPresets)[number]) {
  return {
    policyTargets: Object.fromEntries(
      presetPolicyTargetRoutes(preset).map((name) => [name, MERGE_AUTHORITY]),
    ),
    ...(preset.baseUrl === undefined ? { baseUrl: OWN_HOST } : {}),
  };
}

test("every shipped preset builds into a connector the registry accepts", () => {
  for (const preset of connectorPresets) {
    const connector = buildConnectorPreset(preset.id, bindings(preset));
    assert.deepEqual(
      validateConnector(connector),
      [],
      `${preset.id} must validate: ${validateConnector(connector).join("; ")}`,
    );
  }
});

test("the github preset serves the routes the github-experts blueprint declares", () => {
  const connector = buildConnectorPreset("github", { policyTargets: GITHUB_TARGETS });
  const names = connector.routes.map((r) => r.name);
  // The three the shipped `bot-pr-triage` flow actually calls. If these drift,
  // the crew's tools resolve to nothing at run time.
  assert.ok(names.includes("get_pull_request"));
  assert.ok(names.includes("merge_pull_request"));
  assert.ok(names.includes("create_issue_comment"));
  assert.equal(connector.baseUrl, "https://api.github.com");

  const merge = connector.routes.find((r) => r.name === "merge_pull_request")!;
  assert.equal(merge.method, "PUT");
  assert.equal(merge.path, "/repos/{owner}/{repo}/pulls/{number}/merge");
  assert.equal(merge.effect, "write");
  assert.equal(merge.policyTarget, MERGE_AUTHORITY);

  const comment = connector.routes.find((r) => r.name === "create_issue_comment")!;
  assert.equal(comment.method, "POST");
  // `issues`, not `pulls`: the `pulls` comment endpoint is for review comments
  // and needs a diff position. Getting this wrong is a 422 mid-run.
  assert.equal(comment.path, "/repos/{owner}/{repo}/issues/{number}/comments");
  assert.equal(comment.effect, "write");
  assert.deepEqual(comment.params, ["body"]);
});

test("the comment write is gated by its own address, not the merge authority", () => {
  // The whole reason it is a separate target: the fix-note runs on the path
  // where merging did not happen. One address for both would mean revoking
  // merge rights also silences the explanation of why a PR is stuck.
  const connector = buildConnectorPreset("github", { policyTargets: GITHUB_TARGETS });
  const comment = connector.routes.find((r) => r.name === "create_issue_comment")!;
  assert.equal(comment.policyTarget, COMMENT_AUTHORITY);
  assert.notEqual(comment.policyTarget, MERGE_AUTHORITY);
});

test("commenting can be registered without granting the merge", () => {
  // A crew that reports and never merges is a real configuration, and it must
  // not have to bind a merge authority it will never use to get there.
  const connector = buildConnectorPreset("github", {
    omitRoutes: ["merge_pull_request"],
    policyTargets: { create_issue_comment: COMMENT_AUTHORITY },
  });
  assert.ok(connector.routes.some((r) => r.name === "create_issue_comment"));
  assert.ok(!connector.routes.some((r) => r.name === "merge_pull_request"));
  assert.deepEqual(validateConnector(connector), []);
});

test("the default credential mode is the App, and the PAT is an explicit opt-in", () => {
  // Posture, not preference: a PAT carries its owner's whole account and
  // attributes every crew action to a person. Whichever mode is listed first
  // is what an operator who does not choose ends up running.
  assert.equal(getConnectorPreset("github")!.auth[0]!.mode, "github-app");
  assert.deepEqual(buildConnectorPreset("github", { policyTargets: GITHUB_TARGETS }).auth, {
    kind: "github-app",
    appIdEnv: "GITHUB_APP_ID",
    privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
    installationIdEnv: "GITHUB_APP_INSTALLATION_ID",
  });
  assert.deepEqual(
    buildConnectorPreset("github", {
      authMode: "token",
      policyTargets: GITHUB_TARGETS,
    }).auth,
    { kind: "bearer", tokenEnv: "GH_TOKEN" },
  );
});

test("an unsupported auth mode names the ones that exist", () => {
  assert.throws(
    () => buildConnectorPreset("github", { authMode: "oauth" as never }),
    /connector_preset_unknown_auth_mode:github\.oauth \(supported: github-app, token\)/,
  );
});

test("the merge and the comment are the only writes — a preset does not widen what a token can do", () => {
  const connector = buildConnectorPreset("github", { policyTargets: GITHUB_TARGETS });
  assert.deepEqual(
    connector.routes.filter((r) => r.effect === "write").map((r) => r.name),
    ["create_issue_comment", "merge_pull_request"],
  );
});

test("a write with no policy target is refused rather than registered unadmitted", () => {
  assert.throws(
    () => buildConnectorPreset("github"),
    /connector_preset_unbound_policy_target:github\.(create_issue_comment|merge_pull_request)/,
  );
  // Binding one write does not carry the other in with it.
  assert.throws(
    () =>
      buildConnectorPreset("github", { policyTargets: { merge_pull_request: MERGE_AUTHORITY } }),
    /connector_preset_unbound_policy_target:github\.create_issue_comment/,
  );
});

test("omitting the writes builds a read-only connector without any binding", () => {
  const connector = buildConnectorPreset("github", {
    omitRoutes: ["merge_pull_request", "create_issue_comment"],
  });
  assert.ok(connector.routes.every((r) => r.effect === "read"));
  assert.ok(!connector.routes.some((r) => r.name === "merge_pull_request"));
  assert.ok(!connector.routes.some((r) => r.name === "create_issue_comment"));
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
        policyTargets: { ...GITHUB_TARGETS, get_pull_request: MERGE_AUTHORITY },
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
  assert.throws(() => buildConnectorPreset("bitbucket"), /unknown_connector_preset:bitbucket/);
  assert.throws(() => buildConnectorPreset("bitbucket"), /available: .*github/);
  assert.equal(getConnectorPreset("bitbucket"), undefined);
});

test("overrides cover a self-hosted instance and a renamed credential", () => {
  const connector = buildConnectorPreset("github", {
    id: "ghe",
    authMode: "token",
    baseUrl: "https://github.acme.example/api/v3",
    tokenEnv: "GHE_TOKEN",
    timeoutMs: 5_000,
    policyTargets: GITHUB_TARGETS,
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
      { preset: "github", policyTargets: GITHUB_TARGETS },
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
    routes: [
      { name: "get_post", method: "GET" as const, path: "/posts/{id}", effect: "read" as const },
    ],
  };
  assert.deepEqual(resolveConnectorConfig([written]), [written]);
});

/* ------------------------------------------------------------------ *
 * Catalog-wide invariants. These hold for every preset that ships, so a
 * twelfth one added later cannot quietly break the shape the first eleven
 * established.
 * ------------------------------------------------------------------ */

test("no preset ships a write that could be registered unadmitted", () => {
  for (const preset of connectorPresets) {
    const writes = preset.routes.filter((r) => r.effect === "write");
    for (const route of writes) {
      // The one exception is deliberate and must stay explicit: filing a draft
      // nobody can see is not an action the policy stack has an opinion about.
      if (preset.id === "typefully" && route.name === "create_draft") continue;
      assert.ok(
        route.policyTarget?.required,
        `${preset.id}.${route.name} is a write with no required policy target`,
      );
      assert.ok(
        route.policyTarget!.note.length > 20,
        `${preset.id}.${route.name} target needs a note`,
      );
    }
    // Building with nothing bound must fail rather than register the write.
    if (writes.some((r) => r.policyTarget?.required)) {
      assert.throws(
        () => buildConnectorPreset(preset.id, { baseUrl: preset.baseUrl ?? OWN_HOST }),
        /connector_preset_unbound_policy_target/,
        `${preset.id} built with no binding`,
      );
    }
  }
});

test("every preset can be registered read-only by omitting its writes", () => {
  for (const preset of connectorPresets) {
    const writes = preset.routes.filter((r) => r.effect === "write").map((r) => r.name);
    if (writes.length === 0 || writes.length === preset.routes.length) continue;
    const connector = buildConnectorPreset(preset.id, {
      omitRoutes: writes,
      ...(preset.baseUrl === undefined ? { baseUrl: OWN_HOST } : {}),
    });
    assert.ok(
      connector.routes.every((r) => r.effect === "read"),
      `${preset.id} kept a write after omitting them`,
    );
    assert.deepEqual(validateConnector(connector), []);
  }
});

test("a param never shadows a path placeholder", () => {
  // A name in both places is a transcription slip with a quiet failure mode:
  // the arg fills the path *and* is forwarded as a query parameter or body
  // field, so the call goes somewhere plausible with the wrong shape.
  for (const preset of connectorPresets) {
    for (const route of preset.routes) {
      const placeholders = [...route.path.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!);
      for (const param of route.params ?? []) {
        assert.ok(
          !placeholders.includes(param),
          `${preset.id}.${route.name} declares "${param}" as both a path segment and a param`,
        );
      }
    }
  }
});

test("a public registry sends no credential, and asking it to is an error", () => {
  const connector = buildConnectorPreset("npm");
  assert.deepEqual(connector.auth, { kind: "none" });
  assert.deepEqual(validateConnector(connector), []);
  assert.throws(
    () => buildConnectorPreset("npm", { tokenEnv: "NPM_TOKEN" }),
    /connector_preset_takes_no_credential:npm/,
  );
  // `none` is a mode like the others, so asking for one the preset does not
  // support names what it does support rather than quietly falling back.
  assert.throws(
    () => buildConnectorPreset("npm", { authMode: "token" }),
    /connector_preset_unknown_auth_mode:npm\.token \(supported: none\)/,
  );
});

test("every preset states its credential modes, and every mode names its env", () => {
  for (const preset of connectorPresets) {
    assert.ok(preset.auth.length > 0, `${preset.id} declares no credential mode`);
    for (const auth of preset.auth) {
      assert.ok(auth.label.length > 0, `${preset.id}.${auth.mode} has no label`);
      assert.ok(auth.note.length > 20, `${preset.id}.${auth.mode} has no note`);
      // A mode that reads an env var must name it: the whole contract is that
      // the preset says where the credential comes from and never carries one.
      if (auth.mode === "token") assert.match(auth.env, /^[A-Z][A-Z0-9_]*$/);
      if (auth.mode === "github-app") {
        for (const env of [auth.appIdEnv, auth.privateKeyEnv, auth.installationIdEnv]) {
          assert.match(env, /^[A-Z][A-Z0-9_]*$/);
        }
      }
    }
  }
});

test("the header override applies to a header credential and nothing else", () => {
  // github's default mode is the App, which has no header to move. Reporting
  // that plainly beats silently ignoring the flag on the mode that is actually
  // in force.
  assert.throws(
    () => buildConnectorPreset("github", { credentialHeader: "x-token" }),
    /connector_preset_credential_is_not_a_header:github/,
  );
  assert.throws(
    () => buildConnectorPreset("npm", { credentialHeader: "x-token" }),
    /connector_preset_takes_no_credential:npm/,
  );
});

test("a preset with no default host refuses to build pointed at somebody else's site", () => {
  assert.throws(
    () =>
      buildConnectorPreset("ghost", {
        policyTargets: { create_post: MERGE_AUTHORITY, update_post: MERGE_AUTHORITY },
      }),
    /connector_preset_unbound_base_url:ghost/,
  );
  // The error carries the note, so the operator learns the shape of the URL.
  assert.throws(
    () => buildConnectorPreset("ghost", { omitRoutes: ["create_post", "update_post"] }),
    /ghost\/api\/admin/,
  );
  const connector = buildConnectorPreset("ghost", {
    baseUrl: OWN_HOST,
    omitRoutes: ["create_post", "update_post"],
  });
  assert.equal(connector.baseUrl, OWN_HOST);
});

test("a version pin rides on the connector, not on the caller's args", async () => {
  const seen: Record<string, string>[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const registry = createConnectorRegistry({
    connectors: [buildConnectorPreset("notion")],
    env: { NOTION_TOKEN: "ntn_secret" },
    fetchImpl,
  });
  await registry.call("notion.get_page", { page_id: "abc", "Notion-Version": "2000-01-01" });
  assert.equal(seen[0]!["Notion-Version"], "2022-06-28");
  assert.equal(seen[0]!.authorization, "Bearer ntn_secret");
});

test("filing a draft cannot schedule one — the allowlist is the gate", async () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  // The draft-only posture: the scheduling route is left out entirely, so the
  // crew can write and a human still decides what goes on the wire.
  const registry = createConnectorRegistry({
    connectors: [buildConnectorPreset("typefully", { omitRoutes: ["schedule_draft"] })],
    env: { TYPEFULLY_API_KEY: "Bearer k" },
    fetchImpl,
  });
  assert.equal(registry.handles("typefully.schedule_draft"), false);
  await registry.call("typefully.create_draft", {
    content: "hello",
    "schedule-date": "2026-08-01T09:00:00Z",
  });
  const sent = JSON.parse(bodies[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent), ["content"]);
});

test("CoinGecko Pro is the same preset under another host and header", () => {
  const connector = buildConnectorPreset("coingecko", {
    id: "coingecko-pro",
    baseUrl: "https://pro-api.coingecko.com/api/v3",
    credentialHeader: "x-cg-pro-api-key",
    tokenEnv: "COINGECKO_PRO_KEY",
  });
  assert.deepEqual(connector.auth, {
    kind: "header",
    header: "x-cg-pro-api-key",
    valueEnv: "COINGECKO_PRO_KEY",
  });
  assert.deepEqual(validateConnector(connector), []);
});

test("nothing in the desk's presets can execute a trade", () => {
  // The desk reads prices and simulates calls; moving funds stays an onchain
  // intent through the policy stack. A write appearing here later would be a
  // second execution path with none of that enforcement.
  for (const id of ["uniswap", "tenderly", "coingecko", "defillama", "defillama-yields", "aave"]) {
    const preset = getConnectorPreset(id)!;
    assert.deepEqual(
      preset.routes.filter((r) => r.effect === "write"),
      [],
      `${id} ships a write route`,
    );
  }
});

test("DefiLlama is two presets because it is two hosts", () => {
  // `api.llama.fi/pools` is a 404 — yields live on their own host. Merging the
  // two into one connector would ship a route that fails in the middle of a
  // run, which is the transcription mistake presets exist to prevent.
  const tvl = buildConnectorPreset("defillama");
  const yields = buildConnectorPreset("defillama-yields");
  assert.equal(tvl.baseUrl, "https://api.llama.fi");
  assert.equal(yields.baseUrl, "https://yields.llama.fi");
  assert.notEqual(tvl.baseUrl, yields.baseUrl);
  assert.deepEqual(validateConnector(tvl), []);
  assert.deepEqual(validateConnector(yields), []);
});

test("the market-data presets are public, and asking them for a credential is an error", () => {
  for (const id of ["defillama", "defillama-yields", "aave"]) {
    const connector = buildConnectorPreset(id);
    assert.deepEqual(connector.auth, { kind: "none" }, `${id} sends a credential`);
    assert.throws(
      () => buildConnectorPreset(id, { tokenEnv: "SOME_TOKEN" }),
      new RegExp(`connector_preset_takes_no_credential:${id}`),
    );
  }
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
    connectors: [
      buildConnectorPreset("github", {
        authMode: "token",
        omitRoutes: ["merge_pull_request", "create_issue_comment"],
      }),
    ],
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
