/**
 * Vercel AI SDK–shaped tool adapter (PRD F1.9).
 * No `ai` package dependency yet — exports descriptors + execute fns that map
 * 1:1 onto `tool({ description, parameters, execute })` when you wire the SDK.
 */

import {
  createOrchHttpMcpBackend,
  listLacrewMcpTools,
  runMcpTool,
  type McpToolBackend,
} from "@lacrew/adapter-agents-mcp";

export type VercelAiToolDefinition = {
  description: string;
  /** JSON Schema object (compatible with AI SDK `parameters` / zod-to-json-schema). */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type CreateLacrewVercelAiToolsOptions = {
  /**
   * Live backend for the tools — pass createRuntimeMcpBackend(runtime)
   * in-process or an orchestrator URL string for the HTTP bridge
   * (session-signed onchain calls). Omit for the detached SDK mock.
   */
  backend?: McpToolBackend | string;
  /** SDK fallback flag when no backend is given (default true = mock). */
  useMock?: boolean;
};

/** Build a record of tools ready to spread into `generateText({ tools })`. */
export function createLacrewVercelAiTools(
  opts: CreateLacrewVercelAiToolsOptions = {},
): Record<string, VercelAiToolDefinition> {
  const backend =
    typeof opts.backend === "string"
      ? createOrchHttpMcpBackend(opts.backend, process.env.ORCH_TOKEN?.trim() || undefined)
      : opts.backend;
  const useMock = opts.useMock;
  const out: Record<string, VercelAiToolDefinition> = {};
  for (const t of listLacrewMcpTools()) {
    out[t.name] = {
      description: t.description,
      parameters: t.inputSchema,
      execute: (args) => runMcpTool(t.name, args, { backend, useMock }),
    };
  }
  return out;
}

/** List tool names for docs / registry UIs. */
export function listLacrewVercelAiToolNames(): string[] {
  return Object.keys(createLacrewVercelAiTools());
}

/**
 * Materialize the definitions as real AI SDK tools via the optional `ai`
 * peer (`pnpm add ai`). Each definition maps onto
 * `tool({ description, inputSchema: jsonSchema(...), execute })` — ready to
 * spread into `generateText({ tools })`.
 */
export async function toAiSdkTools(
  opts: CreateLacrewVercelAiToolsOptions = {},
): Promise<Record<string, unknown>> {
  let ai: typeof import("ai");
  try {
    ai = await import("ai");
  } catch {
    throw new Error("ai is not installed — pnpm add ai to use toAiSdkTools()");
  }
  const out: Record<string, unknown> = {};
  for (const [name, d] of Object.entries(createLacrewVercelAiTools(opts))) {
    out[name] = ai.tool({
      description: d.description,
      inputSchema: ai.jsonSchema(d.parameters),
      execute: async (args: unknown) => d.execute((args ?? {}) as Record<string, unknown>),
    });
  }
  return out;
}
