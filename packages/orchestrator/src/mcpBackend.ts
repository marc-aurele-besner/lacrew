/**
 * Bind the MCP tools to the live CrewRuntime so tool calls share the same
 * client, session, and audit trail as the rest of the orchestrator
 * (session-signed onchain proposes when the runtime is onchain).
 */

import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import type { CrewRuntime } from "./runtime.js";

export function createRuntimeMcpBackend(runtime: CrewRuntime): McpToolBackend {
  return {
    getOrgTree: () => runtime.getClient().getOrgTree(),
    listPendingIntents: async () =>
      (await runtime.listPending()).map((intent) => ({
        ...intent,
        value: intent.value.toString(),
      })),
    proposeIntent: async (input) => {
      const { intentId, verdict, txHash } = await runtime.propose(input);
      return { intentId, verdict, txHash };
    },
    resolveIntent: async (intentId, approved) => {
      const { intent, escalated, txHash } = await runtime.resolve(intentId, approved);
      return {
        intent: { ...intent, value: intent.value.toString() },
        escalated,
        txHash,
      };
    },
  };
}
