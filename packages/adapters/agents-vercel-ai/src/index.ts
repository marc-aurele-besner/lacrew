/**
 * Vercel AI SDK–shaped tool adapter (PRD F1.9).
 * No `ai` package dependency yet — exports descriptors + execute fns that map
 * 1:1 onto `tool({ description, parameters, execute })` when you wire the SDK.
 */

import { listLacrewMcpTools, runMcpTool } from "@lacrew/adapter-agents-mcp";

export type VercelAiToolDefinition = {
  description: string;
  /** JSON Schema object (compatible with AI SDK `parameters` / zod-to-json-schema). */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type CreateLacrewVercelAiToolsOptions = {
  useMock?: boolean;
};

/** Build a record of tools ready to spread into `generateText({ tools })`. */
export function createLacrewVercelAiTools(
  opts: CreateLacrewVercelAiToolsOptions = {},
): Record<string, VercelAiToolDefinition> {
  const useMock = opts.useMock ?? true;
  const out: Record<string, VercelAiToolDefinition> = {};
  for (const t of listLacrewMcpTools()) {
    out[t.name] = {
      description: t.description,
      parameters: t.inputSchema,
      execute: (args) => runMcpTool(t.name, args, { useMock }),
    };
  }
  return out;
}

/** List tool names for docs / registry UIs. */
export function listLacrewVercelAiToolNames(): string[] {
  return Object.keys(createLacrewVercelAiTools());
}
