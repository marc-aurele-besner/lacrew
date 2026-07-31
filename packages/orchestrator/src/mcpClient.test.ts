import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExternalMcpRegistry, type ExternalMcpServer } from "./externalMcp.js";
import { createHttpMcpClient, createStdioMcpClient } from "./mcpClient.js";

const MOCK_SERVER = fileURLToPath(new URL("./testdata/mockMcpServer.mjs", import.meta.url));

/** A JSON-RPC MCP server over http, answering whatever the test scripts. */
async function startHttpServer(
  handler: (method: string, params: Record<string, unknown>) => unknown,
  opts: { sse?: boolean } = {},
): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body || "{}") as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      const result = handler(request.method ?? "", request.params ?? {});
      const payload = JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result });
      if (opts.sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${payload}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/rpc`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the http transport handshakes, lists and calls over JSON-RPC", async () => {
  const seen: string[] = [];
  const http = await startHttpServer((method) => {
    seen.push(method);
    if (method === "initialize") return { protocolVersion: "2024-11-05", capabilities: {} };
    if (method === "tools/list") {
      return { tools: [{ name: "search", description: "Search", annotations: { readOnlyHint: true } }] };
    }
    return { content: [{ type: "text", text: "ok" }], isError: false };
  });
  const client = createHttpMcpClient({
    serverId: "gh",
    url: http.url,
    authHeader: () => ({ authorization: "Bearer t" }),
  });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["search"],
  );
  const result = await client.callTool("search", { q: "bug" });
  assert.equal(result.isError, false);
  // The handshake happens once, not per call.
  assert.deepEqual(seen.filter((m) => m === "initialize").length, 1);

  await client.close();
  await http.close();
});

test("an event-stream reply is read for its last frame", async () => {
  const http = await startHttpServer(
    (method) =>
      method === "tools/list"
        ? { tools: [{ name: "search" }] }
        : { protocolVersion: "2024-11-05", capabilities: {} },
    { sse: true },
  );
  const client = createHttpMcpClient({ serverId: "gh", url: http.url });
  assert.deepEqual((await client.listTools()).map((t) => t.name), ["search"]);
  await client.close();
  await http.close();
});

test("a server error surfaces as a refusal, not as an empty tool list", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body || "{}") as { id?: number; method?: string };
      if (request.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: "boom" },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const client = createHttpMcpClient({ serverId: "gh", url: `http://127.0.0.1:${port}/rpc` });

  await assert.rejects(client.listTools(), /mcp_server_error:gh:boom/);
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a response over the size cap is refused rather than buffered", async () => {
  const http = await startHttpServer((method) =>
    method === "tools/list"
      ? { tools: [{ name: "search", description: "x".repeat(5_000) }] }
      : { protocolVersion: "2024-11-05", capabilities: {} },
  );
  const client = createHttpMcpClient({
    serverId: "gh",
    url: http.url,
    maxResponseBytes: 1_000,
  });
  await assert.rejects(client.listTools(), /mcp_response_too_large:gh/);
  await client.close();
  await http.close();
});

test("the stdio transport talks to a real subprocess", async () => {
  const client = createStdioMcpClient({
    serverId: "mock",
    command: process.execPath,
    args: [MOCK_SERVER],
  });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["create_issue", "search_issues"],
  );
  assert.equal(tools.find((t) => t.name === "search_issues")!.annotations?.readOnlyHint, true);

  const result = await client.callTool("search_issues", { q: "bug" });
  assert.equal(result.isError, false);
  await client.close();
});

test("a stdio child is given only the env vars named in config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacrew-mcp-"));
  const script = join(dir, "envDump.mjs");
  // Prints its whole environment as one JSON-RPC "tool", which is the cheapest
  // way to assert what a third-party binary was actually handed.
  writeFileSync(
    script,
    `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\\n");
    continue;
  }
  if (req.method === "tools/list") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: Object.keys(process.env).sort().map((name) => ({ name })) },
      }) + "\\n",
    );
  }
}
`,
  );

  process.env.LACREW_TEST_SECRET = "must-not-leak";
  const client = createStdioMcpClient({
    serverId: "envdump",
    command: process.execPath,
    args: [script],
    env: { PASSED_THROUGH: "yes" },
  });
  const names = (await client.listTools()).map((t) => t.name);
  await client.close();
  delete process.env.LACREW_TEST_SECRET;

  assert.ok(names.includes("PASSED_THROUGH"));
  // Nothing of this process's own environment crosses over. (The platform may
  // add its own variables to any child — `__CF_USER_TEXT_ENCODING` on macOS —
  // so the assertion is about what was inherited, not about the exact set.)
  assert.equal(names.includes("LACREW_TEST_SECRET"), false);
  assert.equal(names.includes("PATH"), false);
});

test("end to end: a real MCP server, the allowlist, and a tool that never runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacrew-mcp-e2e-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");

  const server: ExternalMcpServer = {
    id: "mock",
    transport: "stdio",
    command: process.execPath,
    args: [MOCK_SERVER],
    env: ["MOCK_MCP_LOG", "MOCK_MCP_TOOLS"],
  };
  const env: Record<string, string | undefined> = { MOCK_MCP_LOG: log };
  const registry = createExternalMcpRegistry({ servers: [server], env });

  const [discovered] = await registry.refresh();
  assert.deepEqual(discovered!.added.sort(), ["create_issue", "search_issues"]);

  // Nothing is callable yet, and the far side has no record of being asked.
  await assert.rejects(
    registry.call("mcp__mock__search_issues", { q: "bug" }),
    /tool_not_allowlisted/,
  );
  assert.equal(readFileSync(log, "utf8"), "");

  await registry.setTool({
    scope: { level: "workspace" },
    server: "mock",
    tool: "search_issues",
    enabled: true,
    effect: "read",
  });
  await registry.setTool({
    scope: { level: "workspace" },
    server: "mock",
    tool: "create_issue",
    enabled: true,
    effect: "write",
    mode: "deny",
  });

  const read = await registry.call("mcp__mock__search_issues", { q: "bug" });
  assert.equal(read.untrusted, true);
  assert.deepEqual(read.content, [{ type: "text", text: "called search_issues" }]);

  // A write in deny mode never reaches the process on the other side: the log
  // the server appends to is the proof, not the absence of an exception.
  await assert.rejects(
    registry.call("mcp__mock__create_issue", { title: "hi" }),
    /mcp_mode_denied/,
  );
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["search_issues"]);

  await registry.close();

  // The server grows a tool. A refresh records it, blocked, and calling it
  // still fails until somebody allows it by name.
  env.MOCK_MCP_TOOLS = "3";
  const [second] = await registry.refresh();
  assert.deepEqual(second!.added, ["delete_repository"]);
  await assert.rejects(
    registry.call("mcp__mock__delete_repository", { repo: "lacrew" }),
    /tool_not_allowlisted/,
  );
  assert.equal(readFileSync(log, "utf8").includes("delete_repository"), false);

  await registry.close();
});
