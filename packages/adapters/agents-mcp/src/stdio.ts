/**
 * CLI entry for the LaCrew MCP stdio server.
 * Usage: node --import tsx src/stdio.ts   (or dist after build)
 */

import { startLacrewMcpStdioServer } from "./index.js";

const useMock = process.env.LACREW_MCP_MOCK !== "0";
await startLacrewMcpStdioServer({ useMock });
