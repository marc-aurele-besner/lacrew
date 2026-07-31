/**
 * The operator and flow surfaces over an attached MCP server (F2.30): what the
 * tools page is served, what a `PUT` may and may not change, and what a flow
 * step actually reaches.
 *
 * Driven through the real app and the real registry with only the far side
 * faked — the claims worth testing here are behavioural ("a disabled tool is
 * refused with 403", "a flow step calls nothing until it is allowed"), and a
 * test that stubbed the registry would assert the wiring instead.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flow, FlowWaitingError } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import { createExternalMcpRegistry, type ExternalMcpServer } from "./externalMcp.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createOrchestratorApp } from "./httpApp.js";
import type { McpClient } from "./mcpClient.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import { CrewRuntime } from "./runtime.js";

const SERVER: ExternalMcpServer = {
  id: "gh",
  title: "GitHub MCP",
  transport: "http",
  url: "https://mcp.example.com/rpc",
  auth: { kind: "bearer", tokenEnv: "GH_MCP_TOKEN" },
};

function harness() {
  const calls: string[] = [];
  const client: McpClient = {
    serverId: "gh",
    transport: "http",
    listTools: async () => [
      { name: "search_issues", description: "Search issues", annotations: { readOnlyHint: true } },
      { name: "create_issue", description: "Open an issue" },
    ],
    callTool: async (tool) => {
      calls.push(tool);
      return { content: [{ type: "text", text: `called ${tool}` }], isError: false };
    },
    close: async () => {},
  };

  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const externalMcp = createExternalMcpRegistry({
    servers: [SERVER],
    env: { GH_MCP_TOKEN: "s3cret-token" },
    clientFor: () => client,
    onEvent: (event) => runtime.recordAudit(event),
  });
  const model = new MemoryModelProvider();
  const flows = createFlowsSurface({
    runtime,
    model,
    // Any backend flips the surface off its detached mock onto the live
    // dispatch path, which is where external tools are reached.
    mcpBackend: {} as McpToolBackend,
    store: createMemoryFlowStore(),
    externalMcp,
  });
  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows,
    externalMcp,
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { app, runtime, flows, externalMcp, calls };
}

const allow = (server: string, tool: string, extra: Record<string, unknown> = {}) =>
  new Request("http://x/mcp/servers/tools", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server, tool, enabled: true, ...extra }),
  });

describe("external MCP routes", () => {
  it("serves attached servers with env var names and no credential", async () => {
    const h = harness();
    await h.externalMcp.refresh();

    const res = await h.app.request("/mcp/servers");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes("s3cret-token"), false);
    const body = JSON.parse(text) as {
      servers: Array<{
        id: string;
        auth: { envVars: string[]; ready: boolean };
        tools: Array<{ name: string; enabled: boolean; effect: string }>;
        blockedCount: number;
      }>;
    };
    const server = body.servers[0]!;
    assert.equal(server.id, "gh");
    assert.deepEqual(server.auth.envVars, ["GH_MCP_TOKEN"]);
    assert.equal(server.auth.ready, true);
    assert.equal(server.blockedCount, 2);
    assert.deepEqual(
      server.tools.map((t) => t.enabled),
      [false, false],
    );
  });

  it("answers 503 when no server is attached at all", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const model = new MemoryModelProvider();
    const app = createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model,
      flows: createFlowsSurface({ runtime, model, store: createMemoryFlowStore() }),
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
    });
    const res = await app.request("/mcp/servers");
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, "external_mcp_unavailable");
  });

  it("reports a refresh as a diff and leaves the new tools blocked", async () => {
    const h = harness();
    const res = await h.app.request("/mcp/servers/refresh", { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: Array<{ added: string[]; ok: boolean }> };
    assert.equal(body.results[0]!.ok, true);
    assert.deepEqual(body.results[0]!.added.sort(), ["create_issue", "search_issues"]);

    const call = await h.app.request("/mcp/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mcp__gh__search_issues", arguments: { q: "bug" } }),
    });
    assert.equal(call.status, 403);
    assert.match(((await call.json()) as { error: string }).error, /tool_not_allowlisted/);
    assert.equal(h.calls.length, 0);
  });

  it("allows one tool and calls it, leaving the rest refused", async () => {
    const h = harness();
    await h.externalMcp.refresh();

    const put = await h.app.request(allow("gh", "search_issues", { effect: "read" }));
    assert.equal(put.status, 200);

    const call = await h.app.request("/mcp/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mcp__gh__search_issues", arguments: { q: "bug" } }),
    });
    assert.equal(call.status, 200);
    const body = (await call.json()) as { result: { untrusted: boolean; tool: string } };
    assert.equal(body.result.untrusted, true);
    assert.equal(body.result.tool, "search_issues");
    assert.deepEqual(h.calls, ["search_issues"]);

    const denied = await h.app.request("/mcp/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mcp__gh__create_issue", arguments: { title: "x" } }),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(h.calls, ["search_issues"]);
  });

  it("refuses a wildcard that would admit, and accepts one that narrows", async () => {
    const h = harness();
    await h.externalMcp.refresh();

    const widening = await h.app.request(allow("gh", "*"));
    assert.equal(widening.status, 400);
    assert.match(((await widening.json()) as { error: string }).error, /wildcard may only narrow/);

    const narrowing = await h.app.request("http://x/mcp/servers/tools", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: "gh", tool: "*", enabled: false }),
    });
    assert.equal(narrowing.status, 200);
  });

  it("refuses a malformed scope rather than widening the rule to the workspace", async () => {
    const h = harness();
    await h.externalMcp.refresh();
    const res = await h.app.request("http://x/mcp/servers/tools", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: { level: "team", ref: "0xdesk" },
        server: "gh",
        tool: "search_issues",
        enabled: true,
        effect: "read",
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(h.externalMcp.resolve("gh", "search_issues").enabled, false);
  });

  it("refuses a rule for a server nobody attached", async () => {
    const h = harness();
    const res = await h.app.request(allow("other", "anything"));
    assert.equal(res.status, 404);
  });

  it("clears a rule rather than pinning it to disabled", async () => {
    const h = harness();
    await h.externalMcp.refresh();
    await h.app.request(allow("gh", "search_issues", { effect: "read" }));
    await h.app.request(
      allow("gh", "search_issues", { scope: { level: "agent", ref: "0xabc" }, enabled: false }),
    );
    assert.equal(h.externalMcp.resolve("gh", "search_issues", { principal: "0xabc" }).enabled, false);

    const cleared = await h.app.request("http://x/mcp/servers/tools", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: { level: "agent", ref: "0xabc" },
        server: "gh",
        tool: "search_issues",
      }),
    });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as { cleared: boolean }).cleared, true);
    // Cleared means "inherit again", not "disabled".
    assert.equal(h.externalMcp.resolve("gh", "search_issues", { principal: "0xabc" }).enabled, true);
  });

  it("lists a seat's callable tools beside the first-party ones", async () => {
    const h = harness();
    await h.externalMcp.refresh();
    await h.app.request(allow("gh", "search_issues", { effect: "read" }));
    await h.app.request(
      allow("gh", "search_issues", { scope: { level: "agent", ref: "0xabc" }, enabled: false }),
    );

    const open = (await (await h.app.request("/mcp/tools")).json()) as {
      tools: unknown[];
      external: string[];
    };
    assert.ok(open.tools.length > 0);
    assert.deepEqual(open.external, ["mcp__gh__search_issues"]);

    const seat = (await (await h.app.request("/mcp/tools?as=0xabc")).json()) as {
      external: string[];
    };
    assert.deepEqual(seat.external, []);
  });

  it("records who allowed a tool on the audit trail", async () => {
    const h = harness();
    await h.externalMcp.refresh();
    await h.app.request(allow("gh", "create_issue", { effect: "write", mode: "ask" }));

    const events = await h.runtime.audit();
    const change = events.find((e) => e.type === "ExternalMcpToolPolicyChanged");
    assert.ok(change);
    assert.equal(change.payload.tool, "create_issue");
    assert.equal(change.payload.action, "allowed");
    assert.equal(change.payload.mode, "ask");
  });

  it("reports an ask-mode write as waiting, not as a server failure", async () => {
    // A registry whose ask surface always suspends, which is what the real one
    // does the first time a write in `ask` mode comes through.
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const model = new MemoryModelProvider();
    const externalMcp = createExternalMcpRegistry({
      servers: [SERVER],
      env: { GH_MCP_TOKEN: "s3cret-token" },
      clientFor: () => ({
        serverId: "gh",
        transport: "http",
        listTools: async () => [{ name: "create_issue" }],
        callTool: async () => {
          throw new Error("the call should never have gone out");
        },
        close: async () => {},
      }),
      asks: {
        gate: async () => {
          throw new FlowWaitingError({
            reason: "connector_ask",
            token: "ask_abc123",
            detail: "waiting on a human",
          });
        },
      },
    });
    await externalMcp.refresh();
    await externalMcp.setTool({
      scope: { level: "workspace" },
      server: "gh",
      tool: "create_issue",
      enabled: true,
      effect: "write",
      mode: "ask",
    });
    const app = createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model,
      flows: createFlowsSurface({ runtime, model, store: createMemoryFlowStore() }),
      externalMcp,
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
    });

    const res = await app.request("/mcp/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mcp__gh__create_issue", arguments: { title: "x" } }),
    });
    // 202, not 5xx: the write was held for a human, which is the outcome the
    // operator configured — reporting it as a server fault teaches them to
    // ignore the one status that means "somebody has to answer".
    assert.equal(res.status, 202);
    const body = (await res.json()) as { status: string; reason: string; askId: string };
    assert.equal(body.status, "waiting");
    assert.equal(body.reason, "connector_ask");
    assert.equal(body.askId, "ask_abc123");
  });

  it("pings a server for a setup drawer, and 404s an unknown one", async () => {
    const h = harness();
    const ok = await h.app.request("/mcp/servers/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: "gh" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { tools: number }).tools, 2);

    const missing = await h.app.request("/mcp/servers/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: "nope" }),
    });
    assert.equal(missing.status, 404);
  });
});

describe("external MCP from a flow step", () => {
  it("calls nothing until the tool is allowlisted, then calls it once", async () => {
    const h = harness();
    await h.externalMcp.refresh();
    const def = flow("triage", "Triage issues")
      .tool("search", "mcp__gh__search_issues", { q: "is:open label:bug" })
      .build();
    await h.flows.save(def);

    const refused = await h.flows.run({ id: "triage" });
    assert.equal(refused.status, "error");
    assert.match(refused.steps.at(-1)?.error ?? "", /tool_not_allowlisted/);
    assert.equal(h.calls.length, 0);

    await h.app.request(allow("gh", "search_issues", { effect: "read" }));
    const ran = await h.flows.run({ id: "triage" });
    assert.equal(ran.status, "completed");
    assert.deepEqual(h.calls, ["search_issues"]);
  });
});
