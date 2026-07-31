import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProtocolEvent } from "@lacrew/core";
import {
  createExternalMcpRegistry,
  externalMcpRefreshMinutes,
  externalToolName,
  loadExternalMcpServersFromEnv,
  parseExternalToolName,
  resolveExternalTool,
  validateExternalMcpRule,
  validateExternalMcpServer,
  type ExternalMcpServer,
  type ExternalMcpToolRecord,
} from "./externalMcp.js";
import type { McpClient, McpDiscoveredTool } from "./mcpClient.js";

const SERVER: ExternalMcpServer = {
  id: "gh",
  transport: "http",
  url: "https://mcp.example.com/rpc",
  auth: { kind: "bearer", tokenEnv: "GH_MCP_TOKEN" },
};

const ENV = { GH_MCP_TOKEN: "s3cret-token" };

const TWO_TOOLS: McpDiscoveredTool[] = [
  { name: "search_issues", description: "Search issues", annotations: { readOnlyHint: true } },
  { name: "create_issue", description: "Open an issue" },
];

/** A stand-in server that records every call it was actually asked to make. */
function fakeClient(tools: McpDiscoveredTool[] = TWO_TOOLS) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let published = tools;
  const client: McpClient = {
    serverId: "gh",
    transport: "http",
    listTools: async () => published,
    callTool: async (tool, args) => {
      calls.push({ tool, args });
      return { content: [{ type: "text", text: `called ${tool}` }], isError: false };
    },
    close: async () => {},
  };
  return {
    client,
    calls,
    publish: (next: McpDiscoveredTool[]) => {
      published = next;
    },
  };
}

function harness(opts: { tools?: McpDiscoveredTool[]; asks?: { gate: () => Promise<void> } } = {}) {
  const far = fakeClient(opts.tools ?? TWO_TOOLS);
  const events: ProtocolEvent[] = [];
  const registry = createExternalMcpRegistry({
    servers: [SERVER],
    env: ENV,
    clientFor: () => far.client,
    onEvent: (event) => events.push(event),
    ...(opts.asks ? { asks: opts.asks } : {}),
  });
  return { registry, events, ...far };
}

test("a tool name is namespaced so it cannot shadow a first-party tool", () => {
  assert.equal(externalToolName("gh", "create_issue"), "mcp__gh__create_issue");
  assert.deepEqual(parseExternalToolName("mcp__gh__create_issue"), {
    server: "gh",
    tool: "create_issue",
  });
  // Tool names containing the separator still split at the server boundary.
  assert.deepEqual(parseExternalToolName("mcp__gh__weird__tool"), {
    server: "gh",
    tool: "weird__tool",
  });
  assert.equal(parseExternalToolName("lacrew_propose_intent"), null);
  assert.equal(parseExternalToolName("github.merge_pull_request"), null);
});

test("server config is validated at registration, not at the first call", () => {
  assert.deepEqual(validateExternalMcpServer(SERVER), []);
  assert.match(
    validateExternalMcpServer({ id: "gh", transport: "http", url: "http://mcp.example.com" })[0]!,
    /must be https/,
  );
  assert.match(
    validateExternalMcpServer({ id: "gh", transport: "stdio" })[0]!,
    /needs a command/,
  );
  assert.match(
    validateExternalMcpServer({
      id: "gh",
      transport: "http",
      url: "https://mcp.example.com",
      auth: { kind: "bearer", tokenEnv: "T" },
      headers: { Authorization: "Bearer nope" },
    })[0]!,
    /would override the credential/,
  );
  // Loopback over http is the local-dev case, and is allowed.
  assert.deepEqual(
    validateExternalMcpServer({ id: "gh", transport: "http", url: "http://127.0.0.1:9000/rpc" }),
    [],
  );
});

test("a wildcard rule may narrow but never admit", () => {
  assert.deepEqual(
    validateExternalMcpRule({ scope: { level: "workspace" }, server: "gh", tool: "*", enabled: false }),
    [],
  );
  assert.match(
    validateExternalMcpRule({
      scope: { level: "workspace" },
      server: "gh",
      tool: "*",
      enabled: true,
    })[0]!,
    /wildcard may only narrow/,
  );
});

test("only the workspace may classify a tool as a read", () => {
  assert.match(
    validateExternalMcpRule({
      scope: { level: "agent", ref: "0xabc" },
      server: "gh",
      tool: "create_issue",
      enabled: true,
      effect: "read",
    })[0]!,
    /only set effect at workspace scope/,
  );
  assert.match(
    validateExternalMcpRule({
      scope: { level: "workspace" },
      server: "gh",
      tool: "search_issues",
      enabled: true,
      effect: "read",
      mode: "ask",
    })[0]!,
    /is a read and cannot carry a mode/,
  );
});

test("an unknown tool resolves to a refusal rather than a default", () => {
  const resolved = resolveExternalTool("gh", "delete_repository", []);
  assert.equal(resolved.known, false);
  assert.equal(resolved.enabled, false);
  // Unclassified means write: the tool nobody has looked at is the one to be
  // careful with.
  assert.equal(resolved.effect, "write");
  assert.deepEqual(resolved.source, { kind: "default-deny" });
});

test("discovery records what it found and admits none of it", async () => {
  const { registry, calls } = harness();
  const [result] = await registry.refresh();

  assert.deepEqual(result!.added.sort(), ["create_issue", "search_issues"]);
  assert.equal(result!.ok, true);
  // Nothing is callable off the back of a refresh — that is the whole property.
  assert.deepEqual(registry.toolNames(), []);
  await assert.rejects(
    registry.call("mcp__gh__search_issues", { q: "bug" }),
    /tool_not_allowlisted:gh\.search_issues/,
  );
  assert.equal(calls.length, 0);
});

test("only the enabled tool is callable; the other stays refused", async () => {
  const { registry, calls } = harness();
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "search_issues",
    enabled: true,
    effect: "read",
  });

  const result = await registry.call("mcp__gh__search_issues", { q: "bug" });
  assert.equal(result.server, "gh");
  assert.equal(result.tool, "search_issues");
  // Everything coming back is labelled as somebody else's text.
  assert.equal(result.untrusted, true);
  assert.equal(calls.length, 1);

  await assert.rejects(
    registry.call("mcp__gh__create_issue", { title: "hi" }),
    /tool_not_allowlisted:gh\.create_issue/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(registry.toolNames(), ["mcp__gh__search_issues"]);
});

test("a tool that appears after registration is blocked until allowed", async () => {
  const { registry, calls, publish } = harness();
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "search_issues",
    enabled: true,
    effect: "read",
  });

  publish([...TWO_TOOLS, { name: "delete_repository", description: "Delete a repo" }]);
  const [second] = await registry.refresh();

  assert.deepEqual(second!.added, ["delete_repository"]);
  assert.ok(second!.unchanged.includes("search_issues"));
  await assert.rejects(
    registry.call("mcp__gh__delete_repository", { repo: "lacrew" }),
    /tool_not_allowlisted:gh\.delete_repository/,
  );
  assert.equal(calls.length, 0);

  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "delete_repository",
    enabled: true,
    effect: "write",
    mode: "auto",
  });
  await registry.call("mcp__gh__delete_repository", { repo: "lacrew" });
  assert.equal(calls.length, 1);
});

test("a wildcard deny kills a whole server without touching its records", async () => {
  const { registry, calls } = harness();
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "search_issues",
    enabled: true,
    effect: "read",
  });
  await registry.setTool({
    scope: { level: "agent", ref: "0xAAA" },
    server: "gh",
    tool: "*",
    enabled: false,
  });

  await assert.rejects(
    registry.call("mcp__gh__search_issues", { q: "bug" }, { principal: "0xaaa" }),
    /tool_not_allowlisted/,
  );
  assert.equal(calls.length, 0);
  // Another seat is unaffected: the rule narrowed one agent, not the workspace.
  await registry.call("mcp__gh__search_issues", { q: "bug" }, { principal: "0xbbb" });
  assert.equal(calls.length, 1);
});

test("a crew rule applies through the reporting line", async () => {
  const { registry, calls } = harness();
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "search_issues",
    enabled: true,
    effect: "read",
  });
  await registry.setTool({
    scope: { level: "crew", ref: "0xDESK" },
    server: "gh",
    tool: "search_issues",
    enabled: false,
  });

  await assert.rejects(
    registry.call(
      "mcp__gh__search_issues",
      { q: "bug" },
      { principal: "0xworker", managers: ["0xdesk", "0xroot"] },
    ),
    /tool_not_allowlisted/,
  );
  assert.equal(calls.length, 0);
});

test("a write in deny mode never reaches the server", async () => {
  const { registry, calls, events } = harness();
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "create_issue",
    enabled: true,
    effect: "write",
    mode: "deny",
  });

  await assert.rejects(
    registry.call("mcp__gh__create_issue", { title: "hi" }),
    /mcp_mode_denied:gh\.create_issue/,
  );
  assert.equal(calls.length, 0);
  const refusal = events.filter((e) => e.type === "ExternalMcpCalled").at(-1)!;
  assert.equal(refusal.payload.called, false);
  assert.equal(refusal.payload.refusal, "mode_denied");
});

test("an ask-mode write with no confirmation path is refused, not called", async () => {
  const { registry, calls } = harness();
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "create_issue",
    enabled: true,
    effect: "write",
    mode: "ask",
  });

  await assert.rejects(
    registry.call("mcp__gh__create_issue", { title: "hi" }),
    /mcp_mode_denied:gh\.create_issue:ask_unavailable/,
  );
  assert.equal(calls.length, 0);
});

test("an ask-mode write goes out only after the confirmation clears", async () => {
  const gated: unknown[] = [];
  const { registry, calls } = harness({
    asks: {
      gate: async (request?: unknown) => {
        gated.push(request);
      },
    } as unknown as { gate: () => Promise<void> },
  });
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "create_issue",
    enabled: true,
    effect: "write",
    mode: "ask",
  });

  await registry.call("mcp__gh__create_issue", { title: "hi" }, { principal: "0xabc" });
  assert.equal(gated.length, 1);
  assert.equal(calls.length, 1);
  const request = gated[0] as { connector: string; route: string };
  assert.equal(request.connector, "mcp:gh");
  assert.equal(request.route, "create_issue");
});

test("a seat may be admitted where the workspace is not, and the mode still binds", async () => {
  const { registry, calls } = harness();
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "create_issue",
    enabled: false,
    effect: "write",
    mode: "deny",
  });
  await registry.setTool({
    scope: { level: "agent", ref: "0xabc" },
    server: "gh",
    tool: "create_issue",
    enabled: true,
    mode: "auto",
  });

  // The workspace disabled it, so every other seat is refused by the allowlist
  // before the mode is ever consulted.
  await assert.rejects(
    registry.call("mcp__gh__create_issue", { title: "x" }),
    /tool_not_allowlisted/,
  );
  await registry.call("mcp__gh__create_issue", { title: "x" }, { principal: "0xABC" });
  assert.equal(calls.length, 1);
  // The seat rule could not have re-classified the write as a read, so the
  // effect an operator set at the workspace is the one that applied.
  const resolved = registry.resolve("gh", "create_issue", { principal: "0xabc" });
  assert.equal(resolved.effect, "write");
  assert.equal(resolved.mode, "auto");
});

test("the audit row carries what was called, never the arguments", async () => {
  const { registry, events } = harness();
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "search_issues",
    enabled: true,
    effect: "read",
  });
  await registry.call("mcp__gh__search_issues", { q: "customer-name" }, { principal: "0xabc" });

  const row = events.filter((e) => e.type === "ExternalMcpCalled").at(-1)!;
  assert.equal(row.payload.server, "gh");
  assert.equal(row.payload.tool, "search_issues");
  assert.equal(row.payload.called, true);
  assert.equal(row.payload.ok, true);
  assert.equal(JSON.stringify(row.payload).includes("customer-name"), false);
  assert.equal(row.payload.argKeys, undefined);
});

test("opt-in debug records argument keys and still no values", async () => {
  const far = fakeClient();
  const events: ProtocolEvent[] = [];
  const registry = createExternalMcpRegistry({
    servers: [SERVER],
    env: ENV,
    clientFor: () => far.client,
    onEvent: (event) => events.push(event),
    auditArgKeys: true,
  });
  await registry.refresh();
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "search_issues",
    enabled: true,
    effect: "read",
  });
  await registry.call("mcp__gh__search_issues", { q: "customer-name", limit: 5 });

  const row = events.filter((e) => e.type === "ExternalMcpCalled").at(-1)!;
  assert.deepEqual(row.payload.argKeys, ["limit", "q"]);
  assert.equal(JSON.stringify(row.payload).includes("customer-name"), false);
});

test("describe() names the env vars a server reads and never their values", async () => {
  const { registry } = harness();
  await registry.refresh();
  const [view] = registry.describe();

  assert.deepEqual(view!.auth.envVars, ["GH_MCP_TOKEN"]);
  assert.equal(view!.auth.ready, true);
  assert.equal(JSON.stringify(view).includes("s3cret-token"), false);
  // Two tools discovered, both blocked, and the count is what a UI shows.
  assert.equal(view!.blockedCount, 2);
  assert.deepEqual(
    view!.tools.map((t) => `${t.name}:${t.enabled}`),
    ["create_issue:false", "search_issues:false"],
  );
});

test("a server that cannot be read reports it rather than emptying the allowlist", async () => {
  const unreachable: McpClient = {
    serverId: "gh",
    transport: "http",
    listTools: async () => {
      throw new Error("mcp_http_502:gh");
    },
    callTool: async () => ({ content: null, isError: true }),
    close: async () => {},
  };
  const registry = createExternalMcpRegistry({
    servers: [SERVER],
    env: ENV,
    clientFor: () => unreachable,
  });
  await registry.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "search_issues",
    enabled: true,
    effect: "read",
  });

  const [result] = await registry.refresh();
  assert.equal(result!.ok, false);
  assert.match(result!.error!, /mcp_http_502/);
  // The rule an operator set is still there; only the tool list is stale.
  assert.equal(registry.rules().length, 1);
  assert.match(registry.describe()[0]!.lastRefreshError!, /mcp_http_502/);
});

test("records survive a restart through the store", async () => {
  const saved: ExternalMcpToolRecord[] = [];
  const far = fakeClient();
  const store = {
    loadExternalMcpTools: async () => [...saved],
    saveExternalMcpTool: async (record: ExternalMcpToolRecord) => {
      const at = saved.findIndex(
        (r) => r.server === record.server && r.tool === record.tool && r.scope.level === record.scope.level,
      );
      if (at >= 0) saved[at] = record;
      else saved.push(record);
    },
    removeExternalMcpTool: async () => {},
  };

  const first = createExternalMcpRegistry({
    servers: [SERVER],
    env: ENV,
    clientFor: () => far.client,
    store,
  });
  await first.refresh();
  await first.setTool({
    scope: { level: "workspace" },
    server: "gh",
    tool: "search_issues",
    enabled: true,
    effect: "read",
  });

  const restarted = createExternalMcpRegistry({
    servers: [SERVER],
    env: ENV,
    clientFor: () => far.client,
    store,
  });
  assert.equal(await restarted.hydrate(), 2);
  assert.equal(restarted.resolve("gh", "search_issues").enabled, true);
  assert.equal(restarted.resolve("gh", "create_issue").enabled, false);
  // A restart must not re-report known tools as newly appeared, or every
  // deploy would read as a supply-chain event.
  const [result] = await restarted.refresh();
  assert.deepEqual(result!.added, []);
});

test("a rule for a server nobody registered is refused", async () => {
  const { registry } = harness();
  await assert.rejects(
    registry.setTool({ scope: { level: "workspace" }, server: "other", tool: "x", enabled: true }),
    /unknown_mcp_server:other/,
  );
});

test("config comes from LACREW_MCP_SERVERS, and no config is not an error", () => {
  assert.deepEqual(loadExternalMcpServersFromEnv({}), []);
  const servers = loadExternalMcpServersFromEnv({
    LACREW_MCP_SERVERS: JSON.stringify([SERVER]),
  });
  assert.equal(servers[0]!.id, "gh");
  assert.equal(
    loadExternalMcpServersFromEnv({ LACREW_MCP_SERVERS: JSON.stringify({ servers: [SERVER] }) })
      .length,
    1,
  );
});

test("the refresh cadence is bounded and can be turned off", () => {
  assert.equal(externalMcpRefreshMinutes({}), 60);
  assert.equal(externalMcpRefreshMinutes({ LACREW_MCP_REFRESH_MINUTES: "0" }), 0);
  assert.equal(externalMcpRefreshMinutes({ LACREW_MCP_REFRESH_MINUTES: "0.2" }), 1);
  assert.equal(externalMcpRefreshMinutes({ LACREW_MCP_REFRESH_MINUTES: "nonsense" }), 60);
});
