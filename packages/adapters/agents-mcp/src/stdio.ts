/**
 * CLI entry for the LaCrew MCP stdio server.
 * Usage: node --import tsx src/stdio.ts   (or dist after build)
 *
 * ORCH_URL=http://127.0.0.1:8788 bridges tools to a running orchestrator
 * (live runtime, session-signed onchain calls); ORCH_TOKEN adds the bearer
 * when the orchestrator sets LACREW_ORCH_TOKEN.
 *
 * Without ORCH_URL the server starts but every tool call fails, naming what to
 * set. LACREW_MCP_MOCK=1 opts into the detached demo client instead. The flag
 * reads as an opt-in because an operator who has never heard of it must not be
 * served an invented org tree and told a spend was approved.
 */

import { createOrchHttpMcpBackend, startLacrewMcpStdioServer } from "./index.js";

const orchUrl = process.env.ORCH_URL?.trim();
const backend = orchUrl
  ? createOrchHttpMcpBackend(orchUrl, process.env.ORCH_TOKEN?.trim() || undefined)
  : undefined;
const useMock = process.env.LACREW_MCP_MOCK === "1";

if (!backend && !useMock) {
  console.error(
    "[@lacrew/adapter-agents-mcp] No ORCH_URL set — tool calls will fail until one is. Set ORCH_URL to an orchestrator, or LACREW_MCP_MOCK=1 for the detached demo client.",
  );
}

await startLacrewMcpStdioServer(backend ? { backend } : { useMock });
