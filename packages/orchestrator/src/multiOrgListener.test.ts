/**
 * Multi-org mode over a real socket: the host is served by the same listener
 * the server process builds (`createHttpServer` + `listenHttp`) and asked
 * through `fetch`, so a request reaches an org's app as the node adapter hands
 * it over, not as `app.request` builds it.
 */

import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { flow } from "@lacrew/flows";
import { createHttpServer, listenHttp } from "./httpListen.js";
import { MemoryModelProvider } from "./model/index.js";
import { createMultiOrgHost, forwardedRequest, type MultiOrgHost } from "./multiOrgApp.js";
import { createMemoryOrgDirectory } from "./orgDirectory.js";
import { InMemoryQueue } from "./queue/index.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signLacrewDelivery } from "./webhookSignature.js";

const TOKEN = "multi-org-listener-token";
const ORG = "listener-org";
type Json = Record<string, any>;

describe("multi-org host behind the real HTTP listener", () => {
  let host: MultiOrgHost;
  let queue: InMemoryQueue;
  let server: Server;
  let base = "";

  const call = async (
    method: string,
    path: string,
    options: { body?: string; token?: string | null; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: Json; text: string }> => {
    const token = options.token === undefined ? TOKEN : options.token;
    const res = await fetch(`${base}${path}`, {
      method,
      ...(options.body === undefined ? {} : { body: options.body }),
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    const text = await res.text();
    let body: Json = {};
    try {
      body = JSON.parse(text) as Json;
    } catch {
      /* not JSON: the text is what there is */
    }
    return { status: res.status, body, text };
  };
  const post = (path: string, body: unknown) => call("POST", path, { body: JSON.stringify(body) });

  before(async () => {
    queue = new InMemoryQueue();
    host = createMultiOrgHost({
      directory: createMemoryOrgDirectory(),
      authToken: TOKEN,
      queue,
      model: new MemoryModelProvider(),
      mcpUseMock: false,
      isDbReady: () => false,
      isDbConfigured: () => false,
      env: {},
      idleMs: 0,
    });
    await queue.start({
      onEpoch: host.onEpoch,
      onTick: host.onTick,
      onFlowCron: host.onFlowCron,
      onWebhook: host.onWebhook,
    });
    server = createHttpServer(host.app.fetch);
    await listenHttp(server, 0, () => undefined, { host: "127.0.0.1" });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registered = await call("PUT", `/orgs/${ORG}`, {
      body: JSON.stringify({ mode: "sandbox" }),
    });
    assert.equal(registered.status, 200, registered.text);
  });

  after(async () => {
    await queue.drain();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.close();
    await queue.stop();
  });

  it("answers an org's health", async () => {
    const health = await call("GET", `/o/${ORG}/health`);
    assert.equal(health.status, 200, health.text);
    assert.equal(health.body.org?.id, ORG, health.text);
    // The token travels with the forwarded request and is still asked for.
    const anonymous = await call("GET", `/o/${ORG}/health`, { token: null });
    assert.equal(anonymous.status, 401, anonymous.text);
  });

  it("carries a JSON body on POST and the query on GET", async () => {
    for (const body of ["first", "second"]) {
      const posted = await post(`/o/${ORG}/messages`, {
        thread: "org",
        author: "listener",
        authorKind: "human",
        kind: "note",
        body,
      });
      assert.ok(posted.status === 200 || posted.status === 201, posted.text);
    }
    const all = await call("GET", `/o/${ORG}/messages`);
    assert.equal(all.status, 200, all.text);
    assert.deepEqual(
      (all.body.messages as Json[]).map((message) => message.body).sort(),
      ["first", "second"],
      "each posted body arrived whole",
    );
    const limited = await call("GET", `/o/${ORG}/messages?limit=1`);
    assert.equal(limited.status, 200, limited.text);
    assert.equal((limited.body.messages as Json[]).length, 1, limited.text);
    const unknown = await call("GET", `/o/${ORG}/messages?thread=no-such-thread`);
    assert.equal(unknown.status, 400, unknown.text);
    assert.equal(unknown.body.error, "unknown_thread");
  });

  it("refuses a POST whose body is not JSON, as the org's own app does", async () => {
    const refused = await call("POST", `/o/${ORG}/messages`, {
      body: "thread=org",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(refused.status, 415, refused.text);
  });

  it("delivers a signed hook with no bearer token", async () => {
    const hooked = flow("listener-hooked", "Listener hooked")
      .model("sum", { prompt: "{{input}}" })
      .build();
    const saved = await post(`/o/${ORG}/flows`, { flow: { ...hooked, trigger: "webhook" } });
    assert.equal(saved.status, 200, saved.text);
    const trigger = await post(`/o/${ORG}/flows/triggers`, { flowId: hooked.id });
    assert.equal(trigger.status, 201, trigger.text);
    const hookId = trigger.body.trigger.id as string;
    const delivery = JSON.stringify({ note: "over a socket" });
    const ts = Math.floor(Date.now() / 1000);
    const signed = {
      [SIGNATURE_HEADER.lacrew]: signLacrewDelivery(trigger.body.secret as string, ts, delivery),
      [TIMESTAMP_HEADER]: String(ts),
    };
    const unsigned = await call("POST", `/o/${ORG}/hooks/${hookId}`, {
      body: delivery,
      token: null,
    });
    assert.ok(
      unsigned.status === 401 || unsigned.status === 400,
      `unsigned: ${unsigned.status} ${unsigned.text}`,
    );
    // The signature covers the exact bytes sent, so this passes only when the
    // body and both headers reach the org's app untouched.
    const accepted = await call("POST", `/o/${ORG}/hooks/${hookId}`, {
      body: delivery,
      token: null,
      headers: signed,
    });
    assert.equal(accepted.status, 202, accepted.text);
    await queue.drain();
    const runs = await call("GET", `/o/${ORG}/flows/runs`);
    assert.ok(
      (runs.body.runs as Json[]).some((run) => run.runId === accepted.body.runId),
      "the delivery ran in the org it was sent to",
    );
  });
});

describe("forwardedRequest", () => {
  const target = new URL("http://orchestrator.internal/messages?limit=2");

  it("carries method, headers and a streamed body it has not read", async () => {
    const chunks = ['{"a":', "1}"];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });
    const incoming = new Request("http://public.example/o/acme/messages?limit=2", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lacrew-timestamp": "17" },
      body,
      duplex: "half",
    } as RequestInit);
    const forwarded = forwardedRequest(target, incoming);
    assert.equal(forwarded.url, target.href);
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.headers.get("content-type"), "application/json");
    assert.equal(forwarded.headers.get("x-lacrew-timestamp"), "17");
    assert.equal(chunks.length, 2, "nothing is read until the org's app reads it");
    assert.equal(await forwarded.text(), '{"a":1}');
  });

  it("carries no body on GET and HEAD", () => {
    for (const method of ["GET", "HEAD"]) {
      const forwarded = forwardedRequest(
        target,
        new Request("http://public.example/x", { method }),
      );
      assert.equal(forwarded.method, method);
      assert.equal(forwarded.body, null);
    }
  });

  it("aborts when the incoming request does", () => {
    const controller = new AbortController();
    const incoming = new Request("http://public.example/o/acme/health", {
      signal: controller.signal,
    });
    const forwarded = forwardedRequest(target, incoming);
    assert.equal(forwarded.signal.aborted, false);
    controller.abort();
    assert.equal(forwarded.signal.aborted, true);
  });
});
