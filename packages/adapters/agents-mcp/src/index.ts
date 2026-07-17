/**
 * MCP tool adapter for agent frameworks.
 * Mocked: describes tools only; no MCP server transport yet.
 * TODO: Expose propose_intent / approve_intent / get_allowance as real MCP tools.
 * TODO: Add vercel-ai and langchain adapters as demand shows.
 */

import { createLacrewClient } from "@lacrew/sdk";

export interface McpToolDescriptor {
  name: string;
  description: string;
  // Mocked JSON-schema-ish shape.
  inputSchema: Record<string, unknown>;
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
  ];
}

/** Mocked tool runner backed by the SDK mock client. */
export async function runMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = createLacrewClient({ useMock: true });

  switch (name) {
    case "lacrew_get_org_tree":
      return client.getOrgTree();
    case "lacrew_list_pending_intents": {
      const intents = await client.getPendingIntents();
      return intents.map((i) => ({ ...i, value: i.value.toString() }));
    }
    case "lacrew_propose_intent": {
      // TODO: Validate addresses and bind to the calling agent's session.
      return client.proposeIntent({
        agent: String(args.agent) as `0x${string}`,
        target: String(args.target) as `0x${string}`,
        value: BigInt(String(args.value ?? "0")),
      });
    }
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}
