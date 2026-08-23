import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { createOrchestratorApp, createUnavailableApp } from "./httpApp.js";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { createConnectorModes } from "./connectorPolicy.js";
import { createConnectorAsks } from "./connectorAsks.js";
import { scopeOfThread } from "./conversation.js";
import {
  clampLimit,
  corsHeadersFor,
  isJsonContentType,
  parseBigInt,
  parseCorsOrigins,
  readBodyBounded,
} from "./httpGuards.js";

function buildApp(opts: { corsOrigins?: ReadonlySet<string>; authToken?: string } = {}) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const model = new MemoryModelProvider();
  const flows = createFlowsSurface({ runtime, model });
  const connectorAsks = createConnectorAsks({
    postQuestion: ({ threadId, author, body, options }) =>
      runtime.postMessage({
        scope: scopeOfThread(threadId) ?? { kind: "org" },
        author,
        authorKind: "agent",
        kind: "question",
        body,
        options,
      }),
  });
  return createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows,
    connectorModes: createConnectorModes({}),
    connectorAsks,
    mcpUseMock: true,
    corsOrigins: opts.corsOrigins ?? new Set(),
    ...(opts.authToken ? { authToken: opts.authToken } : {}),
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
}

describe("httpGuards helpers", () => {
  it("parses the origin allowlist loosely and matches it strictly", () => {
    const set = parseCorsOrigins(" https://app.lacrew.xyz/, http://localhost:3100 ,, ");
    assert.deepEqual([...set], ["https://app.lacrew.xyz", "http://localhost:3100"]);
    assert.deepEqual(corsHeadersFor("https://APP.lacrew.xyz", set), {
      "access-control-allow-origin": "https://APP.lacrew.xyz",
      vary: "origin",
    });
    assert.deepEqual(corsHeadersFor("https://evil.example", set), {});
    assert.deepEqual(corsHeadersFor(undefined, set), {});
    assert.deepEqual(corsHeadersFor("https://app.lacrew.xyz", new Set()), {});
  });

  it("recognises JSON content types with parameters and +json suffixes", () => {
    assert.equal(isJsonContentType("application/json"), true);
    assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
    assert.equal(isJsonContentType("application/vnd.api+json"), true);
    assert.equal(isJsonContentType("text/plain;charset=UTF-8"), false);
    assert.equal(isJsonContentType(undefined), false);
  });

  it("clamps page sizes and refuses nonsense", () => {
    assert.equal(clampLimit(undefined, 50, 200), 50);
    assert.equal(clampLimit("", 50, 200), 50);
    assert.equal(clampLimit("abc", 50, 200), 50);
    assert.equal(clampLimit("-5", 50, 200), 1);
    assert.equal(clampLimit("0", 50, 200), 1);
    assert.equal(clampLimit("1e9", 50, 200), 200);
    assert.equal(clampLimit("7.9", 50, 200), 7);
  });

  it("parses integers as bigint and returns null rather than throwing", () => {
    assert.equal(parseBigInt("42"), 42n);
    assert.equal(parseBigInt(" -7 "), -7n);
    assert.equal(parseBigInt(3), 3n);
    assert.equal(parseBigInt(1.5), null);
    assert.equal(parseBigInt("1e3"), null);
    assert.equal(parseBigInt("0x10"), null);
    assert.equal(parseBigInt(""), null);
    assert.equal(parseBigInt(undefined), null);
  });

  it("reads a streamed body up to the cap and refuses past it", async () => {
    const small = new Request("http://x/", { method: "POST", body: "hello" });
    assert.equal(await readBodyBounded(small, 10), "hello");
    const chunks = ["a".repeat(6), "b".repeat(6)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const big = new Request("http://x/", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    assert.equal(await readBodyBounded(big, 10), null);
  });
});

describe("orchestrator app perimeter", () => {
  it("refuses a mutating request whose body is not declared as JSON", async () => {
    const app = buildApp();
    // A cross-site form or a fetch with a string body arrives as text/plain,
    // which is exactly the "simple request" a browser sends with no preflight.
    const res = await app.request("/tick", { method: "POST", body: "{}" });
    assert.equal(res.status, 415);
    assert.deepEqual(await res.json(), { error: "content_type_must_be_json" });
    const ok = await app.request("/tick", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{}",
    });
    assert.equal(ok.status, 200);
  });

  it("lets a body-less POST and GETs through without a content type", async () => {
    const app = buildApp();
    const res = await app.request("/marketplace/withdraw", { method: "POST" });
    assert.notEqual(res.status, 415);
    const health = await app.request("/health");
    assert.equal(health.status, 200);
  });

  it("sends no CORS headers by default, and echoes only an allowlisted origin", async () => {
    const closed = buildApp();
    const res = await closed.request("/health", { headers: { origin: "https://evil.example" } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    const pre = await closed.request("/tick", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
    assert.equal(pre.headers.get("access-control-allow-methods"), null);

    const open = buildApp({ corsOrigins: new Set(["https://app.lacrew.xyz"]) });
    const allowed = await open.request("/health", {
      headers: { origin: "https://app.lacrew.xyz" },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.lacrew.xyz");
    assert.equal(allowed.headers.get("vary"), "origin");
    const preOk = await open.request("/tick", {
      method: "OPTIONS",
      headers: { origin: "https://app.lacrew.xyz", "access-control-request-method": "POST" },
    });
    assert.match(preOk.headers.get("access-control-allow-methods") ?? "", /PUT/);
    const other = await open.request("/health", { headers: { origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });

  it("applies the same perimeter to the no-chain app", async () => {
    const app = createUnavailableApp({
      reason: "no_private_key",
      detail: "PRIVATE_KEY unset",
      isDbReady: () => false,
      isDbConfigured: () => false,
      corsOrigins: new Set(),
    });
    const res = await app.request("/tick", { method: "POST", body: "{}" });
    assert.equal(res.status, 415);
    const health = await app.request("/health", { headers: { origin: "https://evil.example" } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), null);
  });

  it("caps a chunked hook body at the webhook limit", async () => {
    const app = buildApp();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.close();
      },
    });
    const res = await app.request("/hooks/wht_nothing", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    // Either the body cap or the missing webhook surface answers first; what
    // must not happen is a 2 MiB buffer being read for a trigger that does not exist.
    assert.ok(res.status === 413 || res.status === 503, String(res.status));
  });
});
