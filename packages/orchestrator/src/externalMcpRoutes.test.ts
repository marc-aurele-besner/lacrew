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
import { randomBytes } from "node:crypto";
import { before, describe, it } from "node:test";

// Sealing is mandatory for a stored credential, so the suite needs a key.
before(() => {
  process.env.LACREW_SESSION_KEY ??= randomBytes(32).toString("base64");
});
import { flow, FlowWaitingError } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import { createExternalMcpRegistry, type ExternalMcpServer } from "./externalMcp.js";
import { createMcpSecrets } from "./mcpSecrets.js";
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
    assert.equal(
      h.externalMcp.resolve("gh", "search_issues", { principal: "0xabc" }).enabled,
      false,
    );

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
    assert.equal(
      h.externalMcp.resolve("gh", "search_issues", { principal: "0xabc" }).enabled,
      true,
    );
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

/* ——— hosted egress + runtime attach (F2.30 tranche 2) ——— */

const HOSTED_EGRESS = {
  hosted: true,
  allowHosts: ["mcp.example.com"],
  allowStdio: false,
  allowLoopback: false,
  allowEnv: ["GH_MCP_TOKEN"],
};

/** An orchestrator with nothing attached at boot — the hosted pool's shape. */
function emptyHosted() {
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
    servers: [],
    env: { GH_MCP_TOKEN: "s3cret-token" },
    clientFor: () => client,
    onEvent: (event) => runtime.recordAudit(event),
    egress: HOSTED_EGRESS,
  });
  const model = new MemoryModelProvider();
  const flows = createFlowsSurface({
    runtime,
    model,
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

const attach = (server: Record<string, unknown>) =>
  new Request("http://x/mcp/servers/attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server }),
  });

describe("attaching an external MCP server without a restart", () => {
  it("publishes the egress policy so a setup form can be honest about it", async () => {
    const h = emptyHosted();
    const res = await h.app.request("/mcp/servers");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      servers: unknown[];
      egress: { hosted: boolean; allowHosts: string[]; allowStdio: boolean };
    };
    assert.deepEqual(body.servers, []);
    assert.equal(body.egress.hosted, true);
    assert.equal(body.egress.allowStdio, false);
    assert.deepEqual(body.egress.allowHosts, ["mcp.example.com"]);
  });

  it("attaches, discovers, and admits nothing — then the flow runs once allowed", async () => {
    const h = emptyHosted();
    const res = await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "bearer", tokenEnv: "GH_MCP_TOKEN" },
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes("s3cret-token"), false);
    const body = JSON.parse(text) as {
      server: { id: string; origin: string; blockedCount: number };
      refresh: { added: string[] };
    };
    assert.equal(body.server.origin, "runtime");
    assert.equal(body.server.blockedCount, 2);
    assert.deepEqual(body.refresh.added.sort(), ["create_issue", "search_issues"]);

    const def = flow("triage", "Triage issues")
      .tool("search", "mcp__gh__search_issues", { q: "is:open" })
      .build();
    await h.flows.save(def);
    const refused = await h.flows.run({ id: "triage" });
    assert.equal(refused.status, "error");
    assert.equal(h.calls.length, 0);

    await h.app.request(allow("gh", "search_issues", { effect: "read" }));
    const ran = await h.flows.run({ id: "triage" });
    assert.equal(ran.status, "completed");
    // No restart happened between the attach and this call.
    assert.deepEqual(h.calls, ["search_issues"]);
  });

  it("refuses stdio and an off-allowlist host with 403, not a generic 400", async () => {
    const h = emptyHosted();
    const stdio = await h.app.request(
      attach({ id: "local", transport: "stdio", command: "node", args: ["mcp.mjs"] }),
    );
    assert.equal(stdio.status, 403);
    assert.match(((await stdio.json()) as { error: string }).error, /stdio_not_allowed/);

    const offlist = await h.app.request(
      attach({ id: "evil", transport: "http", url: "https://evil.example.net/rpc" }),
    );
    assert.equal(offlist.status, 403);
    assert.match(((await offlist.json()) as { error: string }).error, /host_not_allowlisted/);

    const credential = await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "bearer", tokenEnv: "OPERATOR_GITHUB_TOKEN" },
      }),
    );
    assert.equal(credential.status, 403);
    assert.match(((await credential.json()) as { error: string }).error, /env_not_allowlisted/);

    const servers = (await (await h.app.request("/mcp/servers")).json()) as { servers: unknown[] };
    assert.deepEqual(servers.servers, []);
  });

  it("400s a config this runtime could never use", async () => {
    const h = emptyHosted();
    const res = await h.app.request(attach({ id: "Nope Spaces", transport: "http" }));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_mcp_server");
  });

  it("detaches a runtime server and refuses to pretend about a boot-configured one", async () => {
    const h = emptyHosted();
    await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "bearer", tokenEnv: "GH_MCP_TOKEN" },
      }),
    );
    const detach = (server: string) =>
      h.app.request("/mcp/servers/detach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server }),
      });
    assert.equal((await detach("gh")).status, 200);
    assert.equal((await detach("gh")).status, 404);

    // The boot-configured harness refuses: env is that config's source of truth.
    const booted = harness();
    const res = await booted.app.request("/mcp/servers/detach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: "gh" }),
    });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /mcp_server_is_boot_config/);
  });

  it("records the attach on the trail with the endpoint and env var names only", async () => {
    const h = emptyHosted();
    await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "bearer", tokenEnv: "GH_MCP_TOKEN" },
      }),
    );
    const trail = (await (await h.app.request("/audit")).json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const rows = trail.events.filter((row) => row.type === "ExternalMcpServerChanged");
    assert.ok(rows.length > 0);
    const attached = rows.find((row) => row.payload.action === "attached")!;
    assert.equal(attached.payload.endpoint, "https://mcp.example.com/rpc");
    assert.equal(JSON.stringify(attached.payload).includes("s3cret-token"), false);
  });
});

describe("skill pack requirements over external MCP tools", () => {
  const PACK = {
    id: "gh-triage",
    version: "1.0.0",
    name: "GitHub triage",
    summary: "Triage incoming issues",
    scope: "agent",
    requires: { mcpTools: ["mcp__gh__search_issues"] },
    skills: [
      {
        id: "triage",
        name: "Triage",
        trigger: "when an issue arrives",
        body: "Search the tracker before answering.",
      },
    ],
  };
  const AGENT = "0x1111111111111111111111111111111111111111";

  const install = (app: ReturnType<typeof emptyHosted>["app"]) =>
    app.request("/agents/skills/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: AGENT, pack: PACK }),
    });

  it("refuses a pack whose external tool this workspace has not admitted", async () => {
    const h = emptyHosted();
    // Attached but nothing allowed: the tool exists on the server and is
    // refused here, which is exactly the state `requires` has to catch.
    await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "bearer", tokenEnv: "GH_MCP_TOKEN" },
      }),
    );
    const res = await install(h.app);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { missing: { mcpTools: string[] } };
    assert.deepEqual(body.missing.mcpTools, ["mcp__gh__search_issues"]);
  });

  it("installs once the tool is admitted for that seat", async () => {
    const h = emptyHosted();
    await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "bearer", tokenEnv: "GH_MCP_TOKEN" },
      }),
    );
    await h.app.request(allow("gh", "search_issues", { effect: "read" }));
    const res = await install(h.app);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { installed: number }).installed, 1);
  });

  it("refuses when the tool is admitted for somebody else's seat", async () => {
    const h = emptyHosted();
    await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "bearer", tokenEnv: "GH_MCP_TOKEN" },
      }),
    );
    await h.app.request(
      allow("gh", "search_issues", {
        effect: "read",
        scope: { level: "agent", ref: "0x2222222222222222222222222222222222222222" },
      }),
    );
    const res = await install(h.app);
    assert.equal(res.status, 409);
  });
});

/* ——— bring-your-own-token on a shared worker (F2.30) ——— */

describe("a credential the workspace brought itself", () => {
  const OURS = { level: "crew" as const, ref: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };

  /**
   * A worker with a sealing key, the hosted egress policy, and a transport that
   * records the headers it was actually given — so "the token reached the far
   * side" is proved by the request rather than by the absence of an error.
   */
  function sealedHarness() {
    const sent: Array<Record<string, string>> = [];
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const mcpSecrets = createMcpSecrets({
      onEvent: (event) => runtime.recordAudit(event),
    });
    const externalMcp = createExternalMcpRegistry({
      servers: [],
      env: {},
      egress: HOSTED_EGRESS,
      secrets: mcpSecrets,
      onEvent: (event) => runtime.recordAudit(event),
      clientFor: (server) => ({
        serverId: server.id,
        transport: "http",
        listTools: async () => [
          { name: "search_issues", annotations: { readOnlyHint: true } },
        ],
        callTool: async () => {
          // Resolve exactly as the real transport does, so the assertion is
          // about the credential path and not about a fake that stands in for it.
          const auth = server.auth;
          const value =
            auth?.kind === "secret" ? mcpSecrets.read(auth.secretRef, server.owner) : undefined;
          if (auth?.kind === "secret" && !value) {
            throw new Error(`mcp_missing_credential:${auth.secretRef}`);
          }
          sent.push(value ? { authorization: `Bearer ${value}` } : {});
          return { content: [{ type: "text", text: "ok" }], isError: false };
        },
        close: async () => {},
      }),
    });
    const model = new MemoryModelProvider();
    const app = createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model,
      flows: createFlowsSurface({
        runtime,
        model,
        mcpBackend: {} as McpToolBackend,
        store: createMemoryFlowStore(),
        externalMcp,
      }),
      externalMcp,
      mcpSecrets,
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
    });
    return { app, runtime, externalMcp, mcpSecrets, sent };
  }

  const putSecret = (app: ReturnType<typeof sealedHarness>["app"], body: unknown) =>
    app.request("/mcp/secrets", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores a token, never returns it, and uses it on the call", async () => {
    const h = sealedHarness();
    const put = await putSecret(h.app, {
      ref: "gh",
      value: "ghp_supersecrettoken",
      owner: OURS,
    });
    assert.equal(put.status, 200);
    const putText = await put.text();
    assert.equal(putText.includes("ghp_supersecrettoken"), false);
    assert.match(putText, /"hint":"oken"/);

    // A server that names the secret asks nothing of the worker's environment,
    // which is what lets it pass an egress policy offering no env var.
    const attached = await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "secret", secretRef: "gh" },
        owner: OURS,
      }),
    );
    assert.equal(attached.status, 200);
    const view = (await attached.json()) as {
      server: { auth: { kind: string; envVars: string[]; secretRef?: string; ready: boolean } };
    };
    assert.equal(view.server.auth.kind, "secret");
    assert.deepEqual(view.server.auth.envVars, []);
    assert.equal(view.server.auth.secretRef, "gh");
    assert.equal(view.server.auth.ready, true);

    await h.app.request(allow("gh", "search_issues", { effect: "read" }));
    await h.externalMcp.call("mcp__gh__search_issues", {}, { principal: OURS.ref });
    assert.deepEqual(h.sent, [{ authorization: "Bearer ghp_supersecrettoken" }]);

    // Nothing in the listing, and nothing on the trail, carries the value.
    const listed = await (await h.app.request("/mcp/secrets")).text();
    assert.equal(listed.includes("ghp_supersecrettoken"), false);
    const trail = await (await h.app.request("/audit")).text();
    assert.equal(trail.includes("ghp_supersecrettoken"), false);
    assert.match(trail, /ExternalMcpSecretChanged/);
  });

  it("refuses a server whose credential belongs to another workspace", async () => {
    const h = sealedHarness();
    const THEIRS = { level: "crew" as const, ref: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    await putSecret(h.app, { ref: "gh", value: "theirs-token", owner: THEIRS });

    // Same ref, our server: the resolver looks up by owner and finds nothing.
    await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "secret", secretRef: "gh" },
        owner: OURS,
      }),
    );
    await h.app.request(allow("gh", "search_issues", { effect: "read" }));
    await assert.rejects(
      h.externalMcp.call("mcp__gh__search_issues", {}, { principal: OURS.ref }),
      /mcp_missing_credential:gh/,
    );
    assert.deepEqual(h.sent, [], "no unauthenticated request went out either");
  });

  it("says a credential is missing rather than reporting the server as ready", async () => {
    const h = sealedHarness();
    const attached = await h.app.request(
      attach({
        id: "gh",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        auth: { kind: "secret", secretRef: "never-set" },
        owner: OURS,
      }),
    );
    const view = (await attached.json()) as { server: { auth: { ready: boolean } } };
    assert.equal(view.server.auth.ready, false);
  });

  it("clears a credential and 404s one that was never there", async () => {
    const h = sealedHarness();
    await putSecret(h.app, { ref: "gh", value: "ghp_token", owner: OURS });
    const remove = (ref: string) =>
      h.app.request("/mcp/secrets/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref, owner: OURS }),
      });
    assert.equal((await remove("gh")).status, 200);
    assert.equal((await remove("gh")).status, 404);
  });

  it("400s a ref this runtime could not namespace safely", async () => {
    const h = sealedHarness();
    const res = await putSecret(h.app, { ref: "Not A Ref", value: "x", owner: OURS });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /invalid_mcp_secret/);
  });
});
