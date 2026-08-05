import { strict as assert } from "node:assert";
import { test } from "node:test";
import { crewBlueprints } from "@lacrew/flows";
import {
  buildConnectorPreset,
  connectorPresets,
  getConnectorPreset,
  presetBranchAllowlistRoutes,
  presetPolicyTargetRoutes,
  resolveConnectorConfig,
} from "./connectorPresets.js";
import {
  createConnectorRegistry,
  loadConnectorsFromEnv,
  validateConnector,
  wholeValueRegExp,
} from "./connectors.js";

const MERGE_AUTHORITY = "0x00000000000000000000000000000000000000aa" as const;
const COMMENT_AUTHORITY = "0x00000000000000000000000000000000000000bb" as const;
const PUSH_AUTHORITY = "0x00000000000000000000000000000000000000cc" as const;

/** The branches the fixer's push may land on, as an operator would write them. */
const BOT_BRANCHES = ["dependabot/**", "renovate/**"];

/** Every one of the github preset's writes bound, which is what building it takes. */
const GITHUB_TARGETS = {
  merge_pull_request: MERGE_AUTHORITY,
  create_issue_comment: COMMENT_AUTHORITY,
  push_authority: PUSH_AUTHORITY,
} as const;

/** Every route that can put a commit on a branch — one authority, four calls. */
const PUSH_ROUTES = ["update_file", "create_tree", "create_commit", "update_ref"];

/** The github preset with everything it refuses to guess supplied. */
const GITHUB_BINDINGS = { policyTargets: GITHUB_TARGETS, branches: BOT_BRANCHES };

/** A stand-in host for the presets that ship none, because the site is the operator's. */
const OWN_HOST = "https://blog.example/ghost/api/admin";

/** Everything a preset refuses to guess, filled in so the build can be exercised. */
function bindings(preset: (typeof connectorPresets)[number]) {
  return {
    policyTargets: Object.fromEntries(
      presetPolicyTargetRoutes(preset).map((name) => [name, MERGE_AUTHORITY]),
    ),
    ...(presetBranchAllowlistRoutes(preset).length > 0 ? { branches: BOT_BRANCHES } : {}),
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
  const connector = buildConnectorPreset("github", GITHUB_BINDINGS);
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
  const connector = buildConnectorPreset("github", GITHUB_BINDINGS);
  const comment = connector.routes.find((r) => r.name === "create_issue_comment")!;
  assert.equal(comment.policyTarget, COMMENT_AUTHORITY);
  assert.notEqual(comment.policyTarget, MERGE_AUTHORITY);
});

test("commenting can be registered without granting the merge", () => {
  // A crew that reports and never merges is a real configuration, and it must
  // not have to bind a merge authority it will never use to get there.
  const connector = buildConnectorPreset("github", {
    omitRoutes: ["merge_pull_request", ...PUSH_ROUTES],
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
  assert.deepEqual(buildConnectorPreset("github", GITHUB_BINDINGS).auth, {
    kind: "github-app",
    appIdEnv: "GITHUB_APP_ID",
    privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
    installationIdEnv: "GITHUB_APP_INSTALLATION_ID",
  });
  assert.deepEqual(buildConnectorPreset("github", { ...GITHUB_BINDINGS, authMode: "token" }).auth, {
    kind: "bearer",
    tokenEnv: "GH_TOKEN",
  });
});

test("an unsupported auth mode names the ones that exist", () => {
  assert.throws(
    () => buildConnectorPreset("github", { authMode: "oauth" as never }),
    /connector_preset_unknown_auth_mode:github\.oauth \(supported: github-app, token\)/,
  );
});

test("the comment, the push, and the merge are the only writes — a preset does not widen what a token can do", () => {
  const connector = buildConnectorPreset("github", GITHUB_BINDINGS);
  assert.deepEqual(
    connector.routes.filter((r) => r.effect === "write").map((r) => r.name),
    [
      "create_issue_comment",
      "update_file",
      "create_tree",
      "create_commit",
      "update_ref",
      "merge_pull_request",
    ],
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
    omitRoutes: ["merge_pull_request", "create_issue_comment", ...PUSH_ROUTES],
  });
  assert.ok(connector.routes.every((r) => r.effect === "read"));
  assert.ok(!connector.routes.some((r) => r.name === "merge_pull_request"));
  assert.ok(!connector.routes.some((r) => r.name === "create_issue_comment"));
  assert.ok(!connector.routes.some((r) => r.name === "update_file"));
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
    ...GITHUB_BINDINGS,
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
      { preset: "github", ...GITHUB_BINDINGS },
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

test("nothing in the governance presets can cast a vote", () => {
  // Read-only, and not as a narrowing of what these APIs offer. A Snapshot vote
  // is an EIP-712 message signed by the delegate's key and posted to a
  // different host; a Tally vote is a transaction to a governor, which is an
  // onchain intent through the policy stack. A write route here would be an
  // authority path beside that enforcement rather than through it.
  for (const id of ["snapshot", "tally"]) {
    const preset = getConnectorPreset(id)!;
    assert.deepEqual(
      preset.routes.filter((r) => r.effect === "write"),
      [],
      `${id} ships a write route`,
    );
    assert.deepEqual(presetPolicyTargetRoutes(preset), [], `${id} wants an address for a read`);
    assert.deepEqual(validateConnector(buildConnectorPreset(id)), []);
  }
});

test("the governance presets pin the endpoints they were checked against", () => {
  // Both are one GraphQL endpoint, so which space or organisation a desk reads
  // rides in the query. The hosts are the transcription worth testing: a
  // preset pointed at the wrong one is a 404 in the middle of a sweep.
  const hub = buildConnectorPreset("snapshot");
  assert.equal(hub.baseUrl, "https://hub.snapshot.org");
  assert.deepEqual(
    hub.routes.map((r) => r.name),
    ["query"],
  );
  assert.equal(hub.routes[0]!.path, "/graphql");
  assert.equal(hub.routes[0]!.method, "POST");
  // A POST that reads — the query is a body, not an effect.
  assert.equal(hub.routes[0]!.effect, "read");
  assert.deepEqual(hub.routes[0]!.params, ["query", "variables", "operationName"]);

  const api = buildConnectorPreset("tally");
  assert.equal(api.baseUrl, "https://api.tally.xyz");
  assert.equal(api.routes[0]!.path, "/query");
});

test("the hub sends no credential and Tally's rides in the header it answers to", () => {
  // The split is what makes the desk cheap to start: the public one drives the
  // shipped sweep, so a governance crew needs no key to discover work at all.
  assert.deepEqual(buildConnectorPreset("snapshot").auth, { kind: "none" });
  assert.throws(
    () => buildConnectorPreset("snapshot", { tokenEnv: "SNAPSHOT_TOKEN" }),
    /connector_preset_takes_no_credential:snapshot/,
  );
  // `api-key`, not `authorization`: Tally answers "api key required" to a
  // bearer token, which is a 401 an operator would read as a bad key.
  assert.deepEqual(buildConnectorPreset("tally").auth, {
    kind: "header",
    header: "api-key",
    valueEnv: "TALLY_API_KEY",
  });
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
        omitRoutes: ["merge_pull_request", "create_issue_comment", ...PUSH_ROUTES],
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

/* ——— the push surface (F2.13) ——— */

/** Build the github preset and hand back the route that pushes. */
function pushRoute(options: Parameters<typeof buildConnectorPreset>[1] = GITHUB_BINDINGS) {
  return buildConnectorPreset("github", options).routes.find((r) => r.name === "update_file")!;
}

test("the push is one gated call on the Contents API, not a shell", () => {
  const push = pushRoute();
  assert.equal(push.method, "PUT");
  assert.equal(push.path, "/repos/{owner}/{repo}/contents/{path}");
  assert.equal(push.effect, "write");
  assert.equal(push.policyTarget, PUSH_AUTHORITY);
  // Its own address. A crew that may push is not thereby allowed to merge, and
  // revoking the push must not silence the note saying why a PR is stuck.
  assert.notEqual(push.policyTarget, MERGE_AUTHORITY);
  assert.notEqual(push.policyTarget, COMMENT_AUTHORITY);
  // `ask` for the same reason the merge is: a commit on somebody's branch is
  // public and awkward to take back.
  assert.equal(push.mode, "ask");
});

test("no field on the push could force, delete, or rewrite history", () => {
  const push = pushRoute();
  assert.deepEqual(push.params, ["message", "content", "sha", "branch"]);
  // The allowlist is the control: `force` is not refused by a check somewhere,
  // it is a field the route does not have, so a flow cannot pass one and an
  // undeclared arg is dropped rather than forwarded.
  for (const forbidden of ["force", "ref", "delete", "committer", "author"]) {
    assert.ok(!push.params!.includes(forbidden), `${forbidden} must not be a push param`);
  }
  // And the method that would remove a file is not registered at all.
  const all = buildConnectorPreset("github", GITHUB_BINDINGS).routes;
  assert.ok(!all.some((r) => r.method === "DELETE"));
});

test("a branch glob says what it means: * stays in a segment, ** crosses", () => {
  const oneSegment = pushRoute({ ...GITHUB_BINDINGS, branches: ["dependabot/*"] });
  const test1 = new RegExp(`^(?:${oneSegment.argRules!.branch!.pattern!})$`);
  assert.ok(test1.test("dependabot/npm"));
  assert.ok(!test1.test("dependabot/npm/lodash-4"));
  assert.ok(!test1.test("main"));

  const anyDepth = pushRoute({ ...GITHUB_BINDINGS, branches: ["dependabot/**"] });
  const test2 = new RegExp(`^(?:${anyDepth.argRules!.branch!.pattern!})$`);
  assert.ok(test2.test("dependabot/npm/lodash-4"));
  assert.ok(!test2.test("main"));
  // A ref component git itself refuses, refused ahead of the allowlist.
  assert.ok(!test2.test("dependabot/../main"));
});

test("the push refuses the workflow directory unless the operator replaces the list", () => {
  const byDefault = new RegExp(`^(?:${pushRoute().argRules!.path!.pattern!})$`);
  assert.ok(!byDefault.test(".github/workflows/ci.yml"));
  assert.ok(byDefault.test("src/index.ts"));
  assert.ok(byDefault.test(".github/dependabot.yml"));

  // Opting out is possible and explicit: an operator who trusts branch
  // protection and CODEOWNERS for this can say so.
  const opened = pushRoute({ ...GITHUB_BINDINGS, denyPathPrefixes: [] });
  assert.equal(opened.argRules?.path?.pattern, undefined);
  assert.equal(opened.argRules?.path?.multiSegment, true);
});

test("a push route will not register until the operator names the branches", () => {
  assert.throws(
    () => buildConnectorPreset("github", { policyTargets: GITHUB_TARGETS }),
    /connector_preset_unbound_branch_allowlist:github\.(update_file|update_ref)/,
  );
  // And a branch allowlist for a connector with nothing to constrain is the
  // operator believing they narrowed something. They did not.
  assert.throws(
    () =>
      buildConnectorPreset("github", {
        omitRoutes: [...PUSH_ROUTES, "merge_pull_request", "create_issue_comment"],
        branches: ["dependabot/**"],
      }),
    /connector_preset_takes_no_branch_allowlist:github/,
  );
});

test("no preset ships a branch-writing route without a branch allowlist", () => {
  // Catalog-wide rather than per-preset: the next connector that learns to
  // write to a branch must declare the guard, or this fails rather than
  // shipping a push admitted by nothing but a policy target.
  for (const preset of connectorPresets) {
    for (const route of preset.routes) {
      if (route.effect !== "write") continue;
      if (!(route.params ?? []).includes("branch")) continue;
      assert.equal(
        route.guards?.branchArg,
        "branch",
        `${preset.id}.${route.name} writes to a branch and must declare a branch guard`,
      );
    }
  }
});

test("the file a push carries is read back through a route that returns it verbatim", () => {
  const connector = buildConnectorPreset("github", GITHUB_BINDINGS);
  const raw = connector.routes.find((r) => r.name === "get_file_raw")!;
  const meta = connector.routes.find((r) => r.name === "get_file")!;
  // Same endpoint, two media types: the sha the write pins comes from the JSON
  // representation, and the text a model patches comes from the raw one.
  assert.equal(raw.path, meta.path);
  assert.equal(raw.headers?.accept, "application/vnd.github.raw");
  assert.equal(meta.headers, undefined);
  assert.equal(raw.effect, "read");
  assert.equal(meta.effect, "read");
});

test("a compiled rule carries the operator's own words for it", () => {
  // A status page saying "may push to dependabot/**" is readable; the same
  // claim as a compiled regex is not, and an operator checking their own
  // configuration should not have to recognise one.
  const push = pushRoute();
  assert.equal(push.argRules?.branch?.label, "dependabot/**, renovate/**");
  assert.equal(push.argRules?.path?.label, "not .github/workflows/");
});

test("the atomic push is four calls and one authority", () => {
  const connector = buildConnectorPreset("github", GITHUB_BINDINGS);
  const routes = PUSH_ROUTES.map((n) => connector.routes.find((r) => r.name === n)!);
  // One address for all of them. Four bindings would look like four decisions,
  // and the risk is not the typing — it is an operator eventually binding four
  // different addresses and believing they narrowed something.
  for (const route of routes) {
    assert.equal(route.policyTarget, PUSH_AUTHORITY, `${route.name} shares the push authority`);
  }
  assert.deepEqual(presetPolicyTargetRoutes(getConnectorPreset("github")!), [
    "create_issue_comment",
    "push_authority",
    "merge_pull_request",
  ]);
});

test("only the call that moves the branch stops for a human", () => {
  const connector = buildConnectorPreset("github", GITHUB_BINDINGS);
  const modeOf = (name: string) => connector.routes.find((r) => r.name === name)!.mode;
  // A tree and a commit nothing points at are invisible and get collected. A
  // confirmation there would gate nothing, and three per push is how an
  // operator learns to approve the one that matters without reading it.
  assert.equal(modeOf("create_tree"), undefined);
  assert.equal(modeOf("create_commit"), undefined);
  assert.equal(modeOf("update_ref"), "ask");
});

test("the ref update has no field that could force it", () => {
  const push = buildConnectorPreset("github", GITHUB_BINDINGS).routes.find(
    (r) => r.name === "update_ref",
  )!;
  // GitHub defaults `force` to false, so leaving it out of the allowlist means
  // a non-fast-forward is refused on their side as well as on ours.
  assert.deepEqual(push.params, ["sha"]);
  assert.equal(push.method, "PATCH");
  assert.equal(push.argRules?.branch?.label, "dependabot/**, renovate/**");
});

test("a commit the crew builds cannot be a merge or an orphan", () => {
  const commit = buildConnectorPreset("github", GITHUB_BINDINGS).routes.find(
    (r) => r.name === "create_commit",
  )!;
  assert.equal(commit.argRules?.parents?.wrap, "array");
  assert.equal(commit.argRules?.parents?.required, true);
});

test("every file in a tree is a regular file, and the path denylist reaches inside", () => {
  const tree = buildConnectorPreset("github", GITHUB_BINDINGS).routes.find(
    (r) => r.name === "create_tree",
  )!;
  const items = tree.argRules?.tree?.items;
  // Fixed, not allowlisted: symlink and submodule are not values a call can
  // carry rather than values a check rejects.
  assert.equal(items?.mode?.fixed, "100644");
  assert.equal(items?.type?.fixed, "blob");
  // The operator refused a directory, not a calling convention — so the same
  // refusal lands on the route that writes several files at once.
  assert.equal(items?.path?.label, "not .github/workflows/");
  assert.ok(!wholeValueRegExp(items!.path!.pattern!).test(".github/workflows/ci.yml"));
  assert.ok(wholeValueRegExp(items!.path!.pattern!).test("src/index.ts"));
  assert.equal(tree.argRules?.tree?.maxItems, 20);
});
