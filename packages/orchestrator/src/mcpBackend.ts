/**
 * Bind the MCP tools to the live CrewRuntime so tool calls share the same
 * client, session, and audit trail as the rest of the orchestrator
 * (session-signed onchain proposes when the runtime is onchain).
 */

import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import type { SessionScope } from "@lacrew/core";
import type { CrewRuntime } from "./runtime.js";

/**
 * `principal` is the agent a flow run acts as and `ceiling` the flow's scope
 * cap; both are bound per run so tool calls inherit the run's identity rather
 * than the process-wide worker.
 */
export function createRuntimeMcpBackend(
  runtime: CrewRuntime,
  actor: {
    principal?: `0x${string}`;
    ceiling?: `0x${string}`;
    window?: { start: number; end: number };
    rate?: { maxProposals: number; ratePeriod: number };
    scopes?: SessionScope[];
  } = {},
): McpToolBackend {
  return {
    getOrgTree: () => runtime.getClient().getOrgTree(),
    listPendingIntents: async () =>
      (await runtime.listPending()).map((intent) => ({
        ...intent,
        value: intent.value.toString(),
      })),
    proposeIntent: async (input) => {
      const { intentId, verdict, txHash } = await runtime.propose({
        ...input,
        ceiling: actor.ceiling,
        window: actor.window,
        rate: actor.rate,
        scopes: actor.scopes,
      });
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
    checkPolicy: (input) =>
      runtime.checkEffectivePolicy({ ...input, ceiling: actor.ceiling }),
    orgAction: (input) => runtime.orgAction({ ...input, ...actor }),
    setBudget: (input) => runtime.setBudget({ ...input, ...actor }),
    governance: (input) => runtime.governanceAction(input),
    // invokeAgent is layered on in createFlowsSurface: delegation runs a flow,
    // which only the flows surface can do.
  };
}
