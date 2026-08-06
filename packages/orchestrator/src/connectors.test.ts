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
  assert.equal(calls[0]!.url, "https://api.github.com/repos/marc-aurele-besner/lacrew/pulls/7");
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
  await assert.rejects(() => registry.call("github.close_issue", {}), /unknown_connector_tool/);
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

  const plaintext = validateConnector(githubConnector({ baseUrl: "http://api.example.com" }));
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

  const fromFile = loadConnectorsFromEnv({ LACREW_CONNECTORS: "/etc/lacrew/connectors.json" }, () =>
    JSON.stringify({ connectors: [githubConnector()] }),
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
  await assert.rejects(() =>
    registry.call("github.merge_pull_request", { owner: "a", repo: "b", number: 1 }),
  );
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
    {
      principal: "0x00000000000000000000000000000000000000a1",
      runId: "run-1",
      flowId: "pr-triage",
    },
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

/* ------------------------------------------------------------------ *
 * Response size caps (F2.13)
 *
 * A body is stringified into `{{steps.<id>.json}}` and handed to whatever
 * reads it next, which is usually a model prompt. These pin the ceiling and,
 * more importantly, pin that crossing it *refuses* rather than truncating: a
 * half-object reasons like data and answers like noise.
 * ------------------------------------------------------------------ */

/** A JSON body of a known encoded size, so a limit can be set either side of it. */
function bodyOfBytes(bytes: number): string {
  const wrapper = '{"pad":""}'.length;
  return JSON.stringify({ pad: "x".repeat(Math.max(0, bytes - wrapper)) });
}

/** Streams `text` back in small chunks, so the counting path is the one tested. */
function streamingFetch(text: string, opts: { contentLength?: boolean } = {}) {
  const impl = (async () => {
    const bytes = Buffer.from(text, "utf8");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 1024) {
          controller.enqueue(new Uint8Array(bytes.subarray(i, i + 1024)));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(opts.contentLength ? { "content-length": String(bytes.byteLength) } : {}),
      },
    });
  }) as unknown as typeof fetch;
  return impl;
}

test("a response over the cap is refused with a stable code, not truncated", async () => {
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: streamingFetch(bodyOfBytes(40_000)),
    maxResponseBytes: 10_000,
  });

  await assert.rejects(
    registry.call("github.get_pull_request", { owner: "a", repo: "b", number: 1 }),
    /^Error: connector_response_too_large:github\.get_pull_request:10000$/,
  );
});

test("a refused body never comes back as a partial result", async () => {
  // The acceptance criterion behind the cap: the step fails, so there is no
  // `body` for the runtime to stringify into a prompt. A truncated string that
  // still parsed would be the failure this prevents.
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: streamingFetch(bodyOfBytes(40_000)),
    maxResponseBytes: 10_000,
  });

  const result = await registry
    .call("github.get_pull_request", { owner: "a", repo: "b", number: 1 })
    .catch((err: Error) => err);
  assert.ok(result instanceof Error);
  assert.ok(!("body" in result));
});

test("a body under the cap is returned untouched", async () => {
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: streamingFetch(JSON.stringify({ number: 7, title: "Bump lodash" })),
    maxResponseBytes: 10_000,
  });

  const result = await registry.call("github.get_pull_request", {
    owner: "a",
    repo: "b",
    number: 7,
  });
  assert.deepEqual(result.body, { number: 7, title: "Bump lodash" });
});

test("a declared content-length over the cap is refused before the body is read", async () => {
  // Proven by consequence: the body here is a few bytes, so counting it would
  // pass. Only the header can be what refused, which is the point — an
  // oversized response is turned away without being pulled down first.
  const impl = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "40000" },
    })) as unknown as typeof fetch;

  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    maxResponseBytes: 10_000,
  });

  await assert.rejects(
    registry.call("github.get_pull_request", { owner: "a", repo: "b", number: 1 }),
    /connector_response_too_large/,
  );
});

test("a route's own cap wins over the connector's, which wins over the default", async () => {
  const connector = githubConnector({
    maxResponseBytes: 5_000,
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
        // The bulk route on this connector, raised deliberately.
        maxResponseBytes: 60_000,
      },
    ],
  });
  const registry = createConnectorRegistry({
    connectors: [connector],
    env: TOKEN_ENV,
    fetchImpl: streamingFetch(bodyOfBytes(40_000)),
    maxResponseBytes: 100,
  });

  // Inherits the connector's 5_000 and refuses.
  await assert.rejects(
    registry.call("github.get_pull_request", { owner: "a", repo: "b", number: 1 }),
    /connector_response_too_large:github\.get_pull_request:5000/,
  );
  // Declares 60_000 and passes, despite a lower connector and registry limit.
  const ok = await registry.call("github.list_pull_requests", { owner: "a", repo: "b" });
  assert.equal(ok.ok, true);
});

test("the resolved cap is reported to operator surfaces", () => {
  const registry = createConnectorRegistry({
    connectors: [
      githubConnector({
        maxResponseBytes: 5_000,
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
            maxResponseBytes: 60_000,
          },
        ],
      }),
    ],
    env: TOKEN_ENV,
    maxResponseBytes: 100,
  });

  const [view] = registry.describe();
  assert.equal(view!.maxResponseBytes, 5_000);
  // Already resolved: an operator asking why a step failed needs the limit that
  // applied, not the level it happened to be written at.
  assert.equal(view!.routes.find((r) => r.name === "get_pull_request")!.maxResponseBytes, 5_000);
  assert.equal(view!.routes.find((r) => r.name === "list_pull_requests")!.maxResponseBytes, 60_000);
});

test("a refusal lands on the audit trail rather than vanishing", async () => {
  const events: ProtocolEvent[] = [];
  const registry = createConnectorRegistry({
    connectors: [githubConnector()],
    env: TOKEN_ENV,
    fetchImpl: streamingFetch(bodyOfBytes(40_000)),
    maxResponseBytes: 10_000,
    onEvent: (event) => events.push(event),
  });

  await assert.rejects(
    registry.call("github.get_pull_request", { owner: "a", repo: "b", number: 1 }),
    /connector_response_too_large/,
  );

  assert.equal(events.length, 1);
  const payload = events[0]!.payload as Record<string, unknown>;
  assert.equal(events[0]!.type, "ToolCalled");
  assert.equal(payload.route, "get_pull_request");
  assert.equal(payload.ok, false);
  assert.equal(payload.refused, "response_too_large");
  assert.equal(payload.maxResponseBytes, 10_000);
  // Still no body on the trail — the reason for refusing it does not become a
  // reason to record it.
  assert.ok(!JSON.stringify(payload).includes("xxxx"));
});

test("a cap that would refuse every call is rejected at registration", () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () =>
        createConnectorRegistry({
          connectors: [githubConnector({ maxResponseBytes: bad })],
          env: TOKEN_ENV,
        }),
      /maxResponseBytes must be a positive integer/,
      `${bad} must be refused`,
    );
  }
  assert.deepEqual(
    validateConnector(
      githubConnector({
        routes: [
          {
            name: "get_pull_request",
            method: "GET",
            path: "/repos/{owner}/{repo}/pulls/{number}",
            effect: "read",
            maxResponseBytes: 0,
          },
        ],
      }),
    ).filter((e) => e.includes("maxResponseBytes")).length,
    1,
  );
});

/* ——— argument rules: what a route's fields may say (F2.13) ——— */

/** A push-shaped connector: one file, one branch, one commit. */
function pushConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "github",
    baseUrl: "https://api.github.com",
    auth: { kind: "bearer", tokenEnv: "GH_TOKEN" },
    routes: [
      {
        name: "get_file",
        method: "GET",
        path: "/repos/{owner}/{repo}/contents/{path}",
        effect: "read",
        params: ["ref"],
        argRules: { path: { multiSegment: true } },
      },
      {
        name: "update_file",
        method: "PUT",
        path: "/repos/{owner}/{repo}/contents/{path}",
        effect: "write",
        params: ["message", "content", "sha", "branch"],
        argRules: {
          path: { multiSegment: true, pattern: "(?!(?:\\.github/workflows/)).*" },
          branch: {
            required: true,
            pattern: "(?!.*(?:^|/)\\.\\.?(?:/|$))(?:dependabot/.*|renovate/.*)",
          },
          content: { encode: "base64", maxBytes: 64 },
        },
      },
    ],
    ...overrides,
  };
}

function pushArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: "o",
    repo: "r",
    path: "src/index.ts",
    branch: "dependabot/npm_and_yarn/lodash-4.17.21",
    message: "fix: pin lodash",
    content: "export const x = 1;\n",
    sha: "abc123",
    ...over,
  };
}

test("a push lands on an allowlisted branch, with the file base64 on the wire", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [pushConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  const res = await registry.call("github.update_file", pushArgs());
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.github.com/repos/o/r/contents/src/index.ts");
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, string>;
  // The flow passed plain text; the endpoint takes base64. A model asked to
  // produce base64 itself would fail by producing something that decodes.
  assert.equal(Buffer.from(body.content!, "base64").toString("utf8"), "export const x = 1;\n");
  assert.equal(body.branch, "dependabot/npm_and_yarn/lodash-4.17.21");
});

test("a branch outside the allowlist is refused without the network being reached", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [pushConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  for (const branch of ["main", "dependabot/x/../../main", "evil/dependabot/x"]) {
    await assert.rejects(
      registry.call("github.update_file", pushArgs({ branch })),
      /connector_arg_refused:github\.update_file:branch/,
      `${branch} must be refused`,
    );
  }
  assert.equal(calls.length, 0);
});

test("a push with no branch is refused rather than landing on the default one", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [pushConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  const { branch: _dropped, ...noBranch } = pushArgs();
  // GitHub treats `branch` as optional and commits to the repository's default
  // branch without it, which is the one place a fixer must never land.
  await assert.rejects(
    registry.call("github.update_file", noBranch),
    /connector_missing_arg:branch/,
  );
  assert.equal(calls.length, 0);
});

test("a path argument spans segments but cannot walk out of them", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [pushConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  await registry.call("github.get_file", { owner: "o", repo: "r", path: "src/lib/index.ts" });
  assert.equal(calls[0]!.url, "https://api.github.com/repos/o/r/contents/src/lib/index.ts");

  for (const path of ["../../../user", "src/../../etc/passwd", "src//index.ts"]) {
    await assert.rejects(
      registry.call("github.get_file", { owner: "o", repo: "r", path }),
      /connector_arg_refused:github\.get_file:path/,
      `${path} must be refused`,
    );
  }
  assert.equal(calls.length, 1);
});

test("the paths a push refuses are refused whatever else the call says", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [pushConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  // A crew that can edit the workflow reviewing its work can approve itself.
  await assert.rejects(
    registry.call("github.update_file", pushArgs({ path: ".github/workflows/ci.yml" })),
    /connector_arg_refused:github\.update_file:path/,
  );
  assert.equal(calls.length, 0);
});

test("an oversized file is refused, and the refusal names the limit but not the file", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [pushConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  await assert.rejects(
    registry.call("github.update_file", pushArgs({ content: "y".repeat(65) })),
    (err: Error) => {
      assert.match(err.message, /connector_arg_too_large:github\.update_file:content:64/);
      assert.ok(!err.message.includes("yyyy"));
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("a body over the request cap is refused before it is sent", async () => {
  const { calls, impl } = recordingFetch();
  const registry = createConnectorRegistry({
    connectors: [pushConnector()],
    env: TOKEN_ENV,
    fetchImpl: impl,
    maxRequestBytes: 120,
  });
  await assert.rejects(
    registry.call("github.update_file", pushArgs({ message: "m".repeat(200) })),
    /connector_request_too_large:github\.update_file:120/,
  );
  assert.equal(calls.length, 0);
});

test("a route header rides on that route only, and cannot carry a credential", async () => {
  const { calls, impl } = recordingFetch();
  const connector = pushConnector();
  connector.routes[0]!.headers = { accept: "application/vnd.github.raw" };
  const registry = createConnectorRegistry({
    connectors: [connector],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  await registry.call("github.get_file", { owner: "o", repo: "r", path: "README.md" });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.accept, "application/vnd.github.raw");
  assert.equal(headers.authorization, "Bearer ghp_secret");

  const shadowed = pushConnector();
  shadowed.routes[0]!.headers = { Authorization: "Bearer nope" };
  assert.ok(validateConnector(shadowed).some((e) => e.includes("would override the credential")));
});

test("an argument rule that constrains nothing is rejected at registration", () => {
  const cases: Array<[Partial<Connector>, RegExp]> = [
    [
      { routes: [{ ...pushConnector().routes[1]!, argRules: { nope: { pattern: "x" } } }] },
      /argRules names "nope", which the route does not take/,
    ],
    [
      { routes: [{ ...pushConnector().routes[0]!, argRules: { ref: { json: true } } }] },
      /sends no body, so argRules "ref" cannot use json/,
    ],
    [
      { routes: [{ ...pushConnector().routes[1]!, argRules: { path: { json: true } } }] },
      /is a path argument and cannot carry a list/,
    ],
    [
      {
        routes: [
          {
            ...pushConnector().routes[1]!,
            argRules: { content: { items: { a: { required: true } } } },
          },
        ],
      },
      /declares items but is not json/,
    ],
    [
      {
        routes: [
          {
            ...pushConnector().routes[1]!,
            argRules: { content: { json: true, items: { a: { json: true } } } },
          },
        ],
      },
      /argRules "content.a" cannot use json/,
    ],
    [
      { routes: [{ ...pushConnector().routes[1]!, argRules: { path: { encode: "base64" } } }] },
      /cannot be encoded/,
    ],
    [
      { routes: [{ ...pushConnector().routes[0]!, argRules: { ref: { encode: "base64" } } }] },
      /sends no body/,
    ],
    [
      { routes: [{ ...pushConnector().routes[1]!, argRules: { branch: { pattern: "([" } } }] },
      /pattern is not a regular expression/,
    ],
    [
      { routes: [{ ...pushConnector().routes[1]!, argRules: { branch: { oneOf: [] } } }] },
      /oneOf is empty/,
    ],
  ];
  for (const [overrides, expected] of cases) {
    const errors = validateConnector(pushConnector(overrides));
    assert.ok(
      errors.some((e) => expected.test(e)),
      `expected ${expected} in ${errors.join("; ")}`,
    );
  }
});

test("a pattern matches the whole value, so a prefix cannot slip past it", async () => {
  const { calls, impl } = recordingFetch();
  const connector = pushConnector();
  connector.routes[1]!.argRules = { branch: { required: true, pattern: "release" } };
  const registry = createConnectorRegistry({
    connectors: [connector],
    env: TOKEN_ENV,
    fetchImpl: impl,
  });
  await assert.rejects(
    registry.call("github.update_file", pushArgs({ branch: "release-hijack" })),
    /connector_arg_refused/,
  );
  await registry.call("github.update_file", pushArgs({ branch: "release" }));
  assert.equal(calls.length, 1);
});

test("describe() publishes the constraints a route runs under, and no credential", () => {
  const registry = createConnectorRegistry({ connectors: [pushConnector()], env: TOKEN_ENV });
  const [view] = registry.describe();
  const push = view!.routes.find((r) => r.name === "update_file")!;
  // Public by design: which branches a crew may write to is the operator's own
  // decision, and it belongs where they read what the crew can do.
  assert.match(push.argRules?.branch?.pattern ?? "", /dependabot\//);
  assert.equal(push.maxRequestBytes, 1_048_576);
  assert.ok(!JSON.stringify(view).includes("ghp_secret"));
});

/* ——— list arguments: the atomic push's tree (F2.13) ——— */

/** A create-tree-shaped route: a list of files, each one rebuilt from rules. */
function treeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "github",
    baseUrl: "https://api.github.com",
    auth: { kind: "bearer", tokenEnv: "GH_TOKEN" },
    routes: [
      {
        name: "create_tree",
        method: "POST",
        path: "/repos/{owner}/{repo}/git/trees",
        effect: "write",
        params: ["base_tree", "tree"],
        argRules: {
          base_tree: { required: true },
          tree: {
            required: true,
            json: true,
            maxItems: 2,
            items: {
              path: { required: true, multiSegment: true, pattern: "(?!(?:\\.github/)).*" },
              content: { required: true, maxBytes: 64 },
              mode: { fixed: "100644" },
              type: { fixed: "blob" },
            },
          },
        },
      },
      {
        name: "create_commit",
        method: "POST",
        path: "/repos/{owner}/{repo}/git/commits",
        effect: "write",
        params: ["message", "tree", "parents"],
        argRules: { parents: { required: true, wrap: "array" } },
      },
    ],
    ...overrides,
  };
}

function treeRegistry(fetchImpl: typeof fetch) {
  return createConnectorRegistry({ connectors: [treeConnector()], env: TOKEN_ENV, fetchImpl });
}

const twoFiles = JSON.stringify([
  { path: "src/index.ts", content: "a" },
  { path: "package.json", content: "b" },
]);

test("a tree argument arrives as a list, and every entry is a regular file", async () => {
  const { calls, impl } = recordingFetch();
  await treeRegistry(impl).call("github.create_tree", {
    owner: "o",
    repo: "r",
    base_tree: "ttt",
    tree: twoFiles,
  });
  const body = JSON.parse(String(calls[0]!.init.body)) as { tree: Record<string, string>[] };
  // Two files, one call — the thing a per-file write cannot do, and the reason
  // a three-file repair is one commit and one CI run.
  assert.deepEqual(body.tree, [
    { path: "src/index.ts", content: "a", mode: "100644", type: "blob" },
    { path: "package.json", content: "b", mode: "100644", type: "blob" },
  ]);
});

test("an entry cannot be a symlink, a submodule, or a pointer at somebody else's blob", async () => {
  const { calls, impl } = recordingFetch();
  await treeRegistry(impl).call("github.create_tree", {
    owner: "o",
    repo: "r",
    base_tree: "ttt",
    tree: JSON.stringify([
      // Every one of these is a way out of "fix the build": a symlink reads a
      // file the repo does not contain, a submodule pointer pulls in a whole
      // other repository, and a bare sha points at a blob nobody reviewed.
      { path: "evil", content: "/etc/passwd", mode: "120000", type: "blob" },
      { path: "vendor", content: "x", mode: "160000", type: "commit", sha: "deadbeef" },
    ]),
  });
  const body = JSON.parse(String(calls[0]!.init.body)) as { tree: Record<string, string>[] };
  assert.equal(body.tree[0]!.mode, "100644");
  assert.equal(body.tree[0]!.type, "blob");
  assert.equal(body.tree[1]!.mode, "100644");
  // The keys nobody declared are gone, not narrowed: `sha` never reaches the
  // wire, so an entry the crew did not write cannot be pointed at.
  assert.ok(!JSON.stringify(body).includes("deadbeef"));
  assert.deepEqual(Object.keys(body.tree[0]!).sort(), ["content", "mode", "path", "type"]);
});

test("a tree entry is held to the same rules a single write would be", async () => {
  const { calls, impl } = recordingFetch();
  const registry = treeRegistry(impl);
  const cases: Array<[string, unknown, RegExp]> = [
    [
      "a path the operator refused",
      [{ path: ".github/workflows/ci.yml", content: "x" }],
      /connector_arg_refused:github\.create_tree:tree\[0\]\.path/,
    ],
    [
      "a path that walks out",
      [{ path: "src/../../etc/passwd", content: "x" }],
      /connector_arg_refused:github\.create_tree:tree\[0\]\.path/,
    ],
    [
      "a file over the cap",
      [{ path: "a.ts", content: "y".repeat(65) }],
      /connector_arg_too_large:github\.create_tree:tree\[0\]\.content:64/,
    ],
    ["an entry with no content", [{ path: "a.ts" }], /connector_missing_arg:tree\[0\]\.content/],
    ["an entry that is not an object", ["a.ts"], /connector_arg_refused:github\.create_tree:tree/],
  ];
  for (const [what, tree, expected] of cases) {
    await assert.rejects(
      registry.call("github.create_tree", {
        owner: "o",
        repo: "r",
        base_tree: "t",
        tree: JSON.stringify(tree),
      }),
      expected,
      `${what} must be refused`,
    );
  }
  // Not one of them reached the network.
  assert.equal(calls.length, 0);
});

test("a tree bigger than the cap is refused rather than sent", async () => {
  const { calls, impl } = recordingFetch();
  await assert.rejects(
    treeRegistry(impl).call("github.create_tree", {
      owner: "o",
      repo: "r",
      base_tree: "t",
      tree: JSON.stringify([
        { path: "a", content: "1" },
        { path: "b", content: "2" },
        { path: "c", content: "3" },
      ]),
    }),
    /connector_arg_too_many:github\.create_tree:tree:2/,
  );
  assert.equal(calls.length, 0);
});

test("a list argument that is not JSON fails the call rather than going out as a string", async () => {
  const { calls, impl } = recordingFetch();
  const registry = treeRegistry(impl);
  await assert.rejects(
    registry.call("github.create_tree", {
      owner: "o",
      repo: "r",
      base_tree: "t",
      tree: "sorry, I can't",
    }),
    /connector_arg_not_json:github\.create_tree:tree/,
  );
  await assert.rejects(
    registry.call("github.create_tree", {
      owner: "o",
      repo: "r",
      base_tree: "t",
      tree: '{"path":"a"}',
    }),
    /connector_arg_refused:github\.create_tree:tree/,
  );
  assert.equal(calls.length, 0);

  // A fenced block is the one wrapper a model adds after being told not to, and
  // failing a repair on three backticks is not a safety property.
  await registry.call("github.create_tree", {
    owner: "o",
    repo: "r",
    base_tree: "t",
    tree: "```json\n" + twoFiles + "\n```",
  });
  assert.equal(calls.length, 1);
});

test("a commit this crew builds has exactly one parent", async () => {
  const { calls, impl } = recordingFetch();
  await treeRegistry(impl).call("github.create_commit", {
    owner: "o",
    repo: "r",
    message: "fix",
    tree: "ttt",
    // Whatever the caller passes is one value, and it goes out as a list of
    // one: a second parent would make this a merge and none would orphan it.
    parents: "aaa111",
  });
  const body = JSON.parse(String(calls[0]!.init.body)) as { parents: string[] };
  assert.deepEqual(body.parents, ["aaa111"]);
});
