/**
 * MCP tool adapter for agent frameworks (PRD F1.9).
 * Exposes LaCrew tools over a minimal JSON-RPC stdio MCP server (no SDK vendor lock).
 * Tools dispatch to an injected McpToolBackend (the orchestrator passes its live
 * runtime); without one they fall back to a detached SDK mock client.
 */

import { createInterface } from "node:readline";
import { createLacrewClient } from "@lacrew/sdk";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Minimal surface the tools need. The orchestrator binds this to its
 * CrewRuntime (session-signed onchain calls); tests can pass stubs.
 */
export interface McpToolBackend {
  getOrgTree(): Promise<unknown>;
  listPendingIntents(): Promise<unknown[]>;
  proposeIntent(input: {
    agent: `0x${string}`;
    target: `0x${string}`;
    value: bigint;
  }): Promise<unknown>;
  resolveIntent(intentId: string, approved: boolean): Promise<unknown>;
}

export interface RunMcpToolOptions {
  /** Live backend; takes precedence over the SDK fallback. */
  backend?: McpToolBackend;
  /** SDK fallback flag when no backend is given (default true = mock). */
  useMock?: boolean;
}

export function listLacrewMcpTools(): McpToolDescriptor[] {
  return [
    {
      name: "lacrew_get_org_tree",
      description: "Return the current organization tree nodes.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "lacrew_propose_intent",
      description: "Propose a spend/action intent subject to policy.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          target: { type: "string" },
          value: { type: "string", description: "uint256 as decimal string" },
        },
        required: ["agent", "target", "value"],
      },
    },
    {
      name: "lacrew_list_pending_intents",
      description: "List escalations awaiting approval.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "lacrew_approve_intent",
      description: "Approve or deny a pending escalation intent.",
      inputSchema: {
        type: "object",
        properties: {
          intentId: { type: "string" },
          approved: { type: "boolean" },
        },
        required: ["intentId", "approved"],
      },
    },
  ];
}

/** Detached SDK client backend (mock demo data unless useMock: false). */
export function createSdkMcpBackend(opts: { useMock?: boolean } = {}): McpToolBackend {
  const client = createLacrewClient({ useMock: opts.useMock ?? true });
  return {
    getOrgTree: () => client.getOrgTree(),
    listPendingIntents: () => client.getPendingIntents(),
    proposeIntent: (input) => client.proposeIntent(input),
    resolveIntent: (intentId, approved) => client.resolveIntent(intentId, approved),
  };
}

/** Tool runner; dispatches to opts.backend, else a detached SDK client. */
export async function runMcpTool(
  name: string,
  args: Record<string, unknown>,
  opts: RunMcpToolOptions = {},
): Promise<unknown> {
  const backend = opts.backend ?? createSdkMcpBackend({ useMock: opts.useMock });

  switch (name) {
    case "lacrew_get_org_tree":
      return backend.getOrgTree();
    case "lacrew_list_pending_intents": {
      const intents = await backend.listPendingIntents();
      return intents.map((i) =>
        i && typeof i === "object" && "value" in i
          ? { ...i, value: String((i as { value: unknown }).value) }
          : i,
      );
    }
    case "lacrew_propose_intent": {
      return backend.proposeIntent({
        agent: String(args.agent) as `0x${string}`,
        target: String(args.target) as `0x${string}`,
        value: BigInt(String(args.value ?? "0")),
      });
    }
    case "lacrew_approve_intent": {
      return backend.resolveIntent(String(args.intentId), Boolean(args.approved));
    }
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

/**
 * Minimal MCP stdio server: `initialize`, `tools/list`, `tools/call`.
 * Wire with: `node dist/stdio.js` or `pnpm --filter @lacrew/adapter-agents-mcp mcp`.
 */
export async function startLacrewMcpStdioServer(
  opts: RunMcpToolOptions = {},
): Promise<void> {
  const write = (msg: unknown) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      continue;
    }

    const id = req.id ?? null;
    try {
      if (req.method === "initialize") {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "lacrew", version: "0.0.0" },
          },
        });
        continue;
      }
      if (req.method === "notifications/initialized" || req.method === "ping") {
        if (req.method === "ping") write({ jsonrpc: "2.0", id, result: {} });
        continue;
      }
      if (req.method === "tools/list") {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            tools: listLacrewMcpTools().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });
        continue;
      }
      if (req.method === "tools/call") {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const result = await runMcpTool(name, args, opts);
        write({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  result,
                  (_k, v) => (typeof v === "bigint" ? v.toString() : v),
                  2,
                ),
              },
            ],
          },
        });
        continue;
      }
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
    } catch (err) {
      write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : "tool_error",
        },
      });
    }
  }
}
