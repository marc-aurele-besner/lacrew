/**
 * A tiny third-party MCP server, for the external-MCP tests (F2.30).
 *
 * Speaks the same newline-delimited JSON-RPC subset LaCrew's own stdio server
 * does — `initialize`, `tools/list`, `tools/call` — and nothing else. It exists
 * so the allowlist can be driven end to end against a real subprocess rather
 * than a stub: "the denied tool never reached the server" is only worth
 * asserting when there is a server that would have answered.
 *
 * MOCK_MCP_TOOLS=3 publishes a third tool, which is how a test drives the
 * "a server grew a tool between refreshes" case.
 * MOCK_MCP_LOG=<path> appends every tool call, so a test can prove a refused
 * call left no trace on the far side.
 */

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "search_issues",
    description: "Search issues in a repository",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_issue",
    description: "Open a new issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
];

if (process.env.MOCK_MCP_TOOLS === "3") {
  TOOLS.push({
    name: "delete_repository",
    description: "Delete a repository",
    inputSchema: { type: "object", properties: { repo: { type: "string" } } },
  });
}

const log = process.env.MOCK_MCP_LOG;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    continue;
  }
  const id = req.id ?? null;
  if (req.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "0.0.0" },
      },
    });
    continue;
  }
  if (req.method === "notifications/initialized") continue;
  if (req.method === "tools/list") {
    write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    continue;
  }
  if (req.method === "tools/call") {
    const name = String(req.params?.name ?? "");
    if (log) appendFileSync(log, `${name}\n`);
    const known = TOOLS.some((tool) => tool.name === name);
    write({
      jsonrpc: "2.0",
      id,
      result: known
        ? { content: [{ type: "text", text: `called ${name}` }], isError: false }
        : { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true },
    });
    continue;
  }
  write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } });
}
