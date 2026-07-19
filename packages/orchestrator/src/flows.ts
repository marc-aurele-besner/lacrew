/**
 * Flows surface: stores flow definitions and runs them against the live
 * runtime (model steps → ModelProvider, tool/gate steps → the same MCP
 * backend that signs session-gated onchain proposes). Storage is in-memory
 * for Phase 0. TODO: persist flows + runs via @lacrew/db.
 */

import {
  createMockFlowBackend,
  flowTemplates,
  runFlow,
  validateFlow,
  type FlowBackend,
  type FlowDefinition,
  type FlowRunResult,
  type FlowTemplate,
} from "@lacrew/flows";
import { runMcpTool, type McpToolBackend } from "@lacrew/adapter-agents-mcp";
import type { ModelProvider } from "./model/index.js";
import type { CrewRuntime } from "./runtime.js";

const RUN_RING_MAX = 50;

export type FlowsSurface = {
  list(): FlowDefinition[];
  save(def: FlowDefinition): FlowDefinition;
  remove(id: string): boolean;
  run(input: { id?: string; flow?: FlowDefinition; input?: string }): Promise<FlowRunResult>;
  runs(): FlowRunResult[];
  templates(): FlowTemplate[];
};

export function createFlowsSurface(opts: {
  runtime: CrewRuntime;
  model: ModelProvider;
  /** Live MCP backend; omitted (LACREW_MCP_MOCK=1) falls back to the detached mock. */
  mcpBackend?: McpToolBackend;
}): FlowsSurface {
  const flows = new Map<string, FlowDefinition>();
  const runRing: FlowRunResult[] = [];
  const mocked = !opts.mcpBackend;

  const backend: FlowBackend = mocked
    ? createMockFlowBackend()
    : {
        complete: (input) => opts.model.complete(input),
        callTool: (name, args) =>
          runMcpTool(name, fillGateDefaults(name, args, opts.runtime), {
            backend: opts.mcpBackend,
          }),
      };

  return {
    list: () => [...flows.values()],
    save: (def) => {
      const check = validateFlow(def);
      if (!check.ok) throw new Error(`invalid_flow: ${check.errors.join("; ")}`);
      flows.set(def.id, structuredClone(def));
      opts.runtime.recordAudit({
        type: "FlowSaved",
        at: new Date().toISOString(),
        payload: { flowId: def.id, name: def.name, steps: def.steps.length },
      });
      return def;
    },
    remove: (id) => flows.delete(id),
    run: async (input) => {
      const def =
        input.flow ??
        flows.get(input.id ?? "") ??
        flowTemplates.find((t) => t.definition.id === input.id)?.definition;
      if (!def) throw new Error("flow_not_found");
      const result = await runFlow(def, backend, { input: input.input, mocked });
      runRing.push(result);
      if (runRing.length > RUN_RING_MAX) runRing.splice(0, runRing.length - RUN_RING_MAX);
      opts.runtime.recordAudit({
        type: "FlowRun",
        at: result.finishedAt,
        payload: {
          flowId: result.flowId,
          runId: result.runId,
          status: result.status,
          steps: result.steps.length,
          verdicts: result.steps.filter((s) => s.verdict).map((s) => s.verdict),
          mocked: result.mocked ?? false,
        },
      });
      return result;
    },
    runs: () => [...runRing].reverse(),
    templates: () => flowTemplates,
  };
}

/**
 * Gate steps may omit agent/target; fill them from the runtime's crew worker
 * and configured spend target so flows stay portable across orgs.
 */
function fillGateDefaults(
  name: string,
  args: Record<string, unknown>,
  runtime: CrewRuntime,
): Record<string, unknown> {
  if (name !== "lacrew_propose_intent") return args;
  return {
    agent: args.agent ?? runtime.defaultAgent,
    target: args.target ?? runtime.defaultSpendTarget,
    ...args,
    value: String(args.value ?? "0"),
  };
}
