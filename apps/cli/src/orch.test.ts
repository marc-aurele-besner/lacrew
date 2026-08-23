import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { flagValue, flagValues, hasFlag } from "./args.js";
import { OrchRefusal, orchFetch, orchHeaders, orchUrl } from "./orch.js";

describe("args", () => {
  it("reads a flag's value unless the next token is itself a flag", () => {
    assert.equal(flagValue(["--url", "http://x"], "--url"), "http://x");
    assert.equal(flagValue(["--url", "--json"], "--url"), undefined);
    assert.equal(flagValue(["--json"], "--url"), undefined);
    assert.deepEqual(flagValues(["--as", "a", "--as", "b", "--as"], "--as"), ["a", "b"]);
    assert.equal(hasFlag(["x", "--json"], "--json"), true);
  });
});

describe("orch", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    globalThis.fetch = env_fetch;
  });
  const env_fetch = globalThis.fetch;

  it("resolves the orchestrator url from --url, then ORCH_URL, then the default", () => {
    delete process.env.ORCH_URL;
    assert.equal(orchUrl([]), "http://127.0.0.1:8788");
    process.env.ORCH_URL = "http://env:1/";
    assert.equal(orchUrl([]), "http://env:1");
    assert.equal(orchUrl(["--url", "http://flag:2/"]), "http://flag:2");
  });

  it("dresses requests with JSON and the bearer, letting explicit headers win", () => {
    delete process.env.ORCH_TOKEN;
    assert.deepEqual(orchHeaders({}), {});
    assert.deepEqual(orchHeaders({ body: "{}" }), { "content-type": "application/json" });
    process.env.ORCH_TOKEN = "tok";
    assert.deepEqual(orchHeaders({ body: "{}", headers: { accept: "text/csv" } }), {
      "content-type": "application/json",
      authorization: "Bearer tok",
      accept: "text/csv",
    });
    assert.deepEqual(orchHeaders({}, { json: true }), {
      "content-type": "application/json",
      authorization: "Bearer tok",
    });
  });

  it("turns a non-2xx answer into an OrchRefusal that keeps the body and lists errors", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid", errors: ["a is required", "b too long"] }), {
        status: 400,
        statusText: "Bad Request",
      })) as typeof fetch;
    await assert.rejects(orchFetch([], "/x"), (err: unknown) => {
      assert.ok(err instanceof OrchRefusal);
      assert.equal(err.status, 400);
      assert.equal(err.body.error, "invalid");
      assert.equal(err.message, "invalid\n  a is required\n  b too long");
      return true;
    });
    globalThis.fetch = (async () =>
      new Response("nope", { status: 502, statusText: "Bad Gateway" })) as typeof fetch;
    await assert.rejects(orchFetch([], "/x"), /^Error: 502 Bad Gateway$/);
  });
});
