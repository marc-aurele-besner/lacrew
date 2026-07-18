/**
 * CLI entry for the LaCrew MCP stdio server.
 * Usage: node --import tsx src/stdio.ts   (or dist after build)
 *
 * ORCH_URL=http://127.0.0.1:8788 bridges tools to a running orchestrator
 * (live runtime, session-signed onchain calls); ORCH_TOKEN adds the bearer
 * when the orchestrator sets LACREW_ORCH_TOKEN. Without ORCH_URL the tools
 * fall back to the detached SDK mock.
 */

import { createOrchHttpMcpBackend, startLacrewMcpStdioServer } from "./index.js";

const orchUrl = process.env.ORCH_URL?.trim();
const backend = orchUrl
  ? createOrchHttpMcpBackend(orchUrl, process.env.ORCH_TOKEN?.trim() || undefined)
  : undefined;
const useMock = process.env.LACREW_MCP_MOCK !== "0";

await startLacrewMcpStdioServer(backend ? { backend } : { useMock });
