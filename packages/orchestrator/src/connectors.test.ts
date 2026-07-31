import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProtocolEvent } from "@lacrew/core";
import {
  createConnectorRegistry,
  loadConnectorsFromEnv,
  validateConnector,
  type Connector,
} from "./connectors.js";

const TOKEN_ENV = { GH_TOKEN: "ghp_secret" };

function githubConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "github",
    baseUrl: "https://api.github.com",
    auth: { kind: "bearer", tokenEnv: "GH_TOKEN" },
    routes: [
      {
        name: "get_pull_request",
        method: "GET",
        path: "/repos/{owner}/{repo}/pulls/{number}",
        effect: "read",
      },
      {
        name: "list_pull_requests",
        method: "GET",
        path: "/repos/{owner}/{repo}/pulls",
        effect: "read",
        params: ["state", "per_page"],
      },
      {
        name: "merge_pull_request",
        method: "PUT",
        path: "/repos/{owner}/{repo}/pulls/{number}/merge",
        effect: "write",
        params: ["merge_method", "commit_title"],
        policyTarget: "0x00000000000000000000000000000000000000aa",
      },
    ],
    ...overrides,
  };
}

/** A fetch stub that records what it was asked to do. */
function recordingFetch(response: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(response.body ?? { ok: true }), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("a read route calls the registered URL with the credential from env", async () => {
  const { calls, impl } = recordingFetch({ body: { number: 7, title: "Bump lodash" } });
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });

  const result = await registry.call("github.get_pull_request", {
    owner: "marc-aurele-besner",
    repo: "lacrew",
    number: 7,
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    "https://api.github.com/repos/marc-aurele-besner/lacrew/pulls/7",
  );
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer ghp_secret");
  assert.equal(result.ok, true);
  assert.deepEqual(result.body, { number: 7, title: "Bump lodash" });
});

test("a flow cannot reach a route, host, or method nobody registered", async () => {
  const { impl, calls } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });

  assert.equal(registry.handles("github.close_issue"), false);
  assert.equal(registry.handles("evil.exfiltrate"), false);
  assert.equal(registry.handles("lacrew_propose_intent"), false);
  await assert.rejects(
    () => registry.call("github.close_issue", {}),
    /unknown_connector_tool/,
  );
  assert.equal(calls.length, 0, "an unregistered name must not reach the network");

  assert.deepEqual(registry.toolNames(), [
    "github.get_pull_request",
    "github.list_pull_requests",
    "github.merge_pull_request",
  ]);
});

test("a path argument cannot escape its segment", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });

  await registry.call("github.get_pull_request", {
    owner: "acme",
    // A flow definition arrives as untrusted JSON: this must stay one segment
    // rather than walking up to another endpoint.
    repo: "../../../user/repos",
    number: 1,
  });

  assert.equal(
    calls[0]!.url,
    "https://api.github.com/repos/acme/..%2F..%2F..%2Fuser%2Frepos/pulls/1",
  );
});

test("args outside the route's params are dropped, not forwarded", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    checkPolicy: async () => "ALLOW",
  });

  await registry.call("github.merge_pull_request", {
    owner: "acme",
    repo: "app",
    number: 4,
    merge_method: "squash",
    // Not declared by the route: a definition must not be able to smuggle
    // fields into a request the operator described.
    sha: "deadbeef",
    admin_override: true,
  });

  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.deepEqual(body, { merge_method: "squash" });
});

test("a missing path argument fails before the request goes out", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  await assert.rejects(
    () => registry.call("github.get_pull_request", { owner: "acme", repo: "app" }),
    /connector_missing_arg:number/,
  );
  assert.equal(calls.length, 0);
});

test("a write route is refused unless policy allows it", async () => {
  const { calls, impl } = recordingFetch();
  const denied = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    checkPolicy: async () => "DENY",
  });
  await assert.rejects(
    () => denied.call("github.merge_pull_request", { owner: "a", repo: "b", number: 1 }),
    /connector_denied:github.merge_pull_request:DENY/,
  );
  assert.equal(calls.length, 0, "a denied write must not reach the network");

  // ESCALATE is not permission either: the crew has to wait for the approval.
  const escalated = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    checkPolicy: async () => "ESCALATE",
  });
  await assert.rejects(
    () => escalated.call("github.merge_pull_request", { owner: "a", repo: "b", number: 1 }),
    /connector_denied:.*:ESCALATE/,
  );
  assert.equal(calls.length, 0);
});

test("a registry that cannot ask policy refuses policy-targeted writes", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  await assert.rejects(
    () => registry.call("github.merge_pull_request", { owner: "a", repo: "b", number: 1 }),
    /connector_policy_unavailable/,
  );
  assert.equal(calls.length, 0);
});

test("a missing credential fails the call rather than sending an unauthenticated one", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: {},
    fetchImpl: impl,
  });
  await assert.rejects(
    () => registry.call("github.get_pull_request", { owner: "a", repo: "b", number: 1 }),
    /connector_missing_credential:GH_TOKEN/,
  );
  assert.equal(calls.length, 0);
});

test("every call is audited, with no response body and no credential", async () => {
  const events: ProtocolEvent[] = [];
  const { impl } = recordingFetch({ body: { title: "secret draft copy" } });
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    onEvent: (e) => events.push(e),
  });

  await registry.call("github.get_pull_request", { owner: "a", repo: "b", number: 2 });

  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "ToolCalled");
  const payload = events[0]!.payload as Record<string, unknown>;
  assert.equal(payload.connector, "github");
  assert.equal(payload.route, "get_pull_request");
  assert.equal(payload.effect, "read");
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 200);
  const serialized = JSON.stringify(events[0]);
  assert.ok(!serialized.includes("ghp_secret"), "the credential must never be recorded");
  assert.ok(!serialized.includes("secret draft copy"), "the response body must never be recorded");
  // Nothing to attribute when nobody called it: a caller-less row must not
  // invent a crew, which a period report would then bill.
  assert.equal(payload.agentId, undefined);
  assert.equal(payload.crewId, undefined);
});

test("an audited call names the seat and the crew it is charged to", async () => {
  const events: ProtocolEvent[] = [];
  const { impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    onEvent: (e) => events.push(e),
  });

  const seat = "0x3333333333333333333333333333333333333333";
  const manager = "0x2222222222222222222222222222222222222222";
  await registry.call(
    "github.get_pull_request",
    { owner: "a", repo: "b", number: 2 },
    // `managers` arrives nearest-first, as the flows surface passes it.
    { principal: seat, managers: [manager] },
  );

  const payload = events[0]!.payload as Record<string, unknown>;
  assert.equal(payload.agentId, seat);
  // The crew is the seat's nearest manager — the same reading write policy and
  // inference budgets use, so one call is billed to one desk everywhere.
  assert.equal(payload.crewId, manager);
});

test("a non-2xx response is reported, not thrown away", async () => {
  const { impl } = recordingFetch({ status: 404, body: { message: "Not Found" } });
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  const result = await registry.call("github.get_pull_request", {
    owner: "a",
    repo: "b",
    number: 9,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { message: "Not Found" });
});

test("a constant header cannot be used to smuggle in a second credential", () => {
  // Constant headers exist for version pins. One that could set auth material
  // would be a second way to authenticate, sitting in a field an operator reads
  // as harmless metadata.
  const shadowing = validateConnector({
    id: "sneaky",
    baseUrl: "https://example.com",
    auth: { kind: "bearer", tokenEnv: "TOKEN" },
    headers: { Authorization: "Bearer other" },
    routes: [{ name: "get_thing", method: "GET", path: "/thing", effect: "read" }],
  });
  assert.equal(shadowing.length, 1);
  assert.match(shadowing[0]!, /would override the credential/);

  // Also when the credential rides in a named header rather than authorization.
  const shadowingNamed = validateConnector({
    id: "sneaky",
    baseUrl: "https://example.com",
    auth: { kind: "header", header: "x-api-key", valueEnv: "TOKEN" },
    headers: { "X-Api-Key": "leaked" },
    routes: [{ name: "get_thing", method: "GET", path: "/thing", effect: "read" }],
  });
  assert.equal(shadowingNamed.length, 1);

  const empty = validateConnector({
    id: "blank",
    baseUrl: "https://example.com",
    auth: { kind: "none" },
    headers: { "Notion-Version": "  " },
    routes: [{ name: "get_thing", method: "GET", path: "/thing", effect: "read" }],
  });
  assert.ok(empty.some((e) => /has no value/.test(e)));
});

test("validation rejects the connectors an operator gets wrong", () => {
  assert.deepEqual(validateConnector(githubConnector()), []);

  const plaintext = validateConnector(
    githubConnector({ baseUrl: "http://api.example.com" }),
  );
  assert.ok(plaintext.some((e) => /must be https/.test(e)));

  // Loopback over http is how a local tool server is reached in development.
  assert.deepEqual(
    validateConnector(githubConnector({ id: "local", baseUrl: "http://127.0.0.1:9000" })),
    [],
  );

  const bad = validateConnector({
    id: "Bad Id",
    baseUrl: "not-a-url",
    auth: { kind: "bearer", tokenEnv: "" },
    routes: [
      { name: "ok", method: "GET", path: "no-slash", effect: "read" },
      { name: "ok", method: "GET", path: "/dup", effect: "read" },
      {
        name: "reader",
        method: "GET",
        path: "/x",
        effect: "read",
        policyTarget: "0x00000000000000000000000000000000000000aa",
      },
    ],
  });
  assert.ok(bad.some((e) => /lowercase letters/.test(e)));
  assert.ok(bad.some((e) => /baseUrl is not a URL/.test(e)));
  assert.ok(bad.some((e) => /needs tokenEnv/.test(e)));
  assert.ok(bad.some((e) => /path must start with/.test(e)));
  assert.ok(bad.some((e) => /duplicate route/.test(e)));
  assert.ok(bad.some((e) => /is a read and cannot carry a policyTarget/.test(e)));
});

test("an invalid connector is rejected at registration, not dropped quietly", () => {
  assert.throws(
    () =>
      createConnectorRegistry({
        connectors: [githubConnector({ baseUrl: "http://api.example.com" })],
        env: TOKEN_ENV,
      }),
    /invalid_connector/,
  );
});

test("config loads from inline JSON or a file, and no config is not an error", () => {
  assert.deepEqual(loadConnectorsFromEnv({}), []);

  const inline = loadConnectorsFromEnv({
    LACREW_CONNECTORS: JSON.stringify([githubConnector()]),
  });
  assert.equal(inline[0]!.id, "github");

  const fromFile = loadConnectorsFromEnv(
    { LACREW_CONNECTORS: "/etc/lacrew/connectors.json" },
    () => JSON.stringify({ connectors: [githubConnector()] }),
  );
  assert.equal(fromFile[0]!.routes.length, 3);

  assert.throws(
    () => loadConnectorsFromEnv({ LACREW_CONNECTORS: "/nope.json" }),
    /connector_config_unreadable/,
  );
});

/* ——— write modes (F2.24) ——— */

test("deny mode never reaches the network, and says so distinctly", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    checkPolicy: async () => "ALLOW",
    resolveMode: () => ({ mode: "deny", source: { kind: "route-default" } }),
  });

  await assert.rejects(
    () => registry.call("github.merge_pull_request", { owner: "acme", repo: "site", number: 7 }),
    /connector_mode_denied:github\.merge_pull_request/,
  );
  assert.equal(calls.length, 0, "no HTTP request, and no policy read either");
});

test("deny is answered before the policy stack is even asked", async () => {
  let policyReads = 0;
  const { impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    checkPolicy: async () => {
      policyReads += 1;
      return "ALLOW";
    },
    resolveMode: () => ({ mode: "deny", source: { kind: "route-default" } }),
  });
  await assert.rejects(() => registry.call("github.merge_pull_request", { owner: "a", repo: "b", number: 1 }));
  assert.equal(policyReads, 0);
});

test("a policy DENY refuses before any question is asked", async () => {
  let gated = 0;
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    checkPolicy: async () => "DENY",
    resolveMode: () => ({ mode: "ask", source: { kind: "route-default" } }),
    asks: {
      gate: async () => {
        gated += 1;
      },
    },
  });

  await assert.rejects(
    () => registry.call("github.merge_pull_request", { owner: "acme", repo: "site", number: 7 }),
    /connector_denied:github\.merge_pull_request:DENY/,
  );
  assert.equal(gated, 0, "a route policy refused must not spam a human with a question");
  assert.equal(calls.length, 0);
});

test("ask mode gates on the built request, not the raw args", async () => {
  const { calls, impl } = recordingFetch();
  const gates: unknown[] = [];
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    checkPolicy: async () => "ALLOW",
    resolveMode: () => ({ mode: "ask", source: { kind: "route-default" } }),
    asks: {
      gate: async (input) => {
        gates.push(input);
      },
    },
  });

  await registry.call(
    "github.merge_pull_request",
    { owner: "acme", repo: "site", number: 7, merge_method: "squash", sneaky: "dropped" },
    { principal: "0x00000000000000000000000000000000000000a1", runId: "run-1", flowId: "pr-triage" },
  );

  assert.deepEqual(gates, [
    {
      connector: "github",
      route: "merge_pull_request",
      method: "PUT",
      path: "/repos/acme/site/pulls/7/merge",
      args: { merge_method: "squash" },
      principal: "0x00000000000000000000000000000000000000a1",
      flowId: "pr-triage",
      runId: "run-1",
    },
  ]);
  assert.equal(calls.length, 1, "the gate returned, so the call went out once");
});

test("ask mode with nowhere to put the question refuses rather than calling", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    checkPolicy: async () => "ALLOW",
    resolveMode: () => ({ mode: "ask", source: { kind: "route-default" } }),
  });
  await assert.rejects(
    () => registry.call("github.merge_pull_request", { owner: "a", repo: "b", number: 1 }),
    /connector_ask_unavailable/,
  );
  assert.equal(calls.length, 0);
});

test("reads are untouched by modes", async () => {
  const { calls, impl } = recordingFetch({ body: { number: 7 } });
  let gated = 0;
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    resolveMode: () => ({ mode: "deny", source: { kind: "route-default" } }),
    asks: {
      gate: async () => {
        gated += 1;
      },
    },
  });
  const result = await registry.call("github.get_pull_request", {
    owner: "acme",
    repo: "site",
    number: 7,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(gated, 0);
});

test("an admitted write in auto mode still goes straight out", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    checkPolicy: async () => "ALLOW",
    resolveMode: () => ({ mode: "auto", source: { kind: "route-default" } }),
    asks: {
      gate: async () => {
        throw new Error("ask machinery must not be reached in auto mode");
      },
    },
  });
  const result = await registry.call("github.merge_pull_request", {
    owner: "acme",
    repo: "site",
    number: 7,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test("a route declaring a mode is described with it, and reads carry none", () => {
  const registry = createConnectorRegistry({
    connectors: [
      githubConnector({
        routes: [
          ...githubConnector().routes.filter((r) => r.name !== "merge_pull_request"),
          {
            name: "merge_pull_request",
            method: "PUT",
            path: "/repos/{owner}/{repo}/pulls/{number}/merge",
            effect: "write",
            mode: "ask",
            policyTarget: "0x00000000000000000000000000000000000000aa",
          },
        ],
      }),
    ],
    env: TOKEN_ENV,
  });
  const routes = registry.describe()[0]!.routes;
  const merge = routes.find((r) => r.name === "merge_pull_request")!;
  const read = routes.find((r) => r.name === "get_pull_request")!;
  assert.equal(merge.mode, "ask");
  assert.equal(merge.effectiveMode?.mode, "ask");
  assert.equal(read.mode, null);
  assert.equal(read.effectiveMode, null);
});

test("a read that declares a mode is refused at registration", () => {
  assert.throws(
    () =>
      createConnectorRegistry({
        connectors: [
          githubConnector({
            routes: [
              {
                name: "get_pull_request",
                method: "GET",
                path: "/repos/{owner}/{repo}/pulls/{number}",
                effect: "read",
                mode: "ask",
              },
            ],
          }),
        ],
        env: TOKEN_ENV,
      }),
    /is a read and cannot carry a mode/,
  );
});
