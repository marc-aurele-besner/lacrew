/**
 * LangChain-shaped adapter (PRD F1.9 / F3.3).
 * No `langchain` / `@langchain/core` dependency yet — mirrors the vercel-ai
 * adapter pattern: exports tool descriptors whose shape maps 1:1 onto
 * `DynamicStructuredTool` / `StructuredToolInterface` (name, description,
 * JSON-Schema `schema`, `invoke`), plus bridges in both directions:
 *
 * - LangChain agents use LaCrew: `createLacrewLangChainTools()` gives any
 *   LangChain agent policy-checked LaCrew tools (org tree, propose, approve).
 * - LaCrew flows use LangChain: `createLangChainFlowBackend()` lets a
 *   LangChain runnable (any object with `invoke()`) serve as the model side
 *   of a `@lacrew/flows` FlowBackend, so LangChain chains become flow steps.
 */

import {
  createOrchHttpMcpBackend,
  listLacrewMcpTools,
  runMcpTool,
  type McpToolBackend,
} from "@lacrew/adapter-agents-mcp";
import type { FlowBackend } from "@lacrew/flows";

/**
 * Shape-compatible with LangChain's StructuredToolInterface: pass each entry
 * to `new DynamicStructuredTool({ name, description, schema, func: invoke })`
 * when wiring the real package. `invoke` returns a JSON string, matching
 * LangChain's string-output tool convention.
 */
export type LangChainToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema object (LangChain accepts JSON Schema alongside zod). */
  schema: Record<string, unknown>;
  invoke: (args: Record<string, unknown>) => Promise<string>;
};

export type CreateLacrewLangChainToolsOptions = {
  /**
   * Live backend — pass createRuntimeMcpBackend(runtime) in-process or an
   * orchestrator URL string for the HTTP bridge (session-signed onchain
   * calls). Omit for the detached SDK mock.
   */
  backend?: McpToolBackend | string;
  /** SDK fallback flag when no backend is given (default true = mock). */
  useMock?: boolean;
};

/** Build LangChain-shaped tools over the LaCrew MCP tool set. */
export function createLacrewLangChainTools(
  opts: CreateLacrewLangChainToolsOptions = {},
): LangChainToolDefinition[] {
  const backend =
    typeof opts.backend === "string"
      ? createOrchHttpMcpBackend(opts.backend, process.env.ORCH_TOKEN?.trim() || undefined)
      : opts.backend;
  const useMock = opts.useMock ?? true;
  return listLacrewMcpTools().map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.inputSchema,
    invoke: async (args) => {
      const result = await runMcpTool(t.name, args, { backend, useMock });
      return JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    },
  }));
}

/** List tool names for docs / registry UIs. */
export function listLacrewLangChainToolNames(): string[] {
  return listLacrewMcpTools().map((t) => t.name);
}

/**
 * Minimal structural view of a LangChain runnable (`Runnable.invoke`) — any
 * chain, chat model, or agent executor satisfies it without importing
 * @langchain/core here.
 */
export type LangChainRunnableLike = {
  invoke: (input: unknown) => Promise<unknown>;
};

export type LangChainFlowBackendOptions = {
  /** Runnable used for `model` steps (chat model, chain, agent executor…). */
  runnable: LangChainRunnableLike;
  /** Tool backend for `tool`/`gate` steps; same options as the tools factory. */
  backend?: McpToolBackend | string;
  useMock?: boolean;
};

/** Read text out of common runnable outputs (string | AIMessage-like | other). */
function runnableText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const content = (output as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof part === "string" ? part : String((part as { text?: unknown })?.text ?? ""),
        )
        .join("");
    }
    const text = (output as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(output);
}

/**
 * FlowBackend whose `model` steps run through a LangChain runnable — drop a
 * LangChain chain into any `@lacrew/flows` pipeline while tool/gate steps keep
 * riding the policy-checked LaCrew backend.
 */
export function createLangChainFlowBackend(opts: LangChainFlowBackendOptions): FlowBackend {
  const backend =
    typeof opts.backend === "string"
      ? createOrchHttpMcpBackend(opts.backend, process.env.ORCH_TOKEN?.trim() || undefined)
      : opts.backend;
  const useMock = opts.useMock ?? true;
  return {
    complete: async ({ system, prompt, model }) => {
      const input = system ? `${system}\n\n${prompt}` : prompt;
      const output = await opts.runnable.invoke(input);
      return { text: runnableText(output), model: model ?? "langchain" };
    },
    callTool: (name, args) => runMcpTool(name, args, { backend, useMock }),
  };
}

/**
 * Materialize the definitions as real LangChain tools via the optional
 * `@langchain/core` peer (`pnpm add @langchain/core`). Each definition maps
 * onto `tool(func, { name, description, schema })` with its JSON Schema —
 * ready for `createReactAgent` / `bindTools`.
 */
export async function toLangChainTools(
  opts: CreateLacrewLangChainToolsOptions = {},
): Promise<unknown[]> {
  let tools: typeof import("@langchain/core/tools");
  try {
    tools = await import("@langchain/core/tools");
  } catch {
    throw new Error(
      "@langchain/core is not installed — pnpm add @langchain/core to use toLangChainTools()",
    );
  }
  return createLacrewLangChainTools(opts).map((d) =>
    tools.tool(async (args: unknown) => d.invoke((args ?? {}) as Record<string, unknown>), {
      name: d.name,
      description: d.description,
      schema: d.schema,
    }),
  );
}
