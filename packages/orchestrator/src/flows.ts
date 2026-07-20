/**
 * Flows surface: stores flow definitions and runs them against the live
 * runtime (model steps → ModelProvider, tool/gate steps → the same MCP
 * backend that signs session-gated onchain proposes). Definitions + run
 * traces persist through a FlowStore (Postgres when DATABASE_URL is set;
 * memory fallback keeps everything working detached).
 */

import {
  createMockFlowBackend,
  cronMatches,
  flowTemplates,
  runFlow,
  validateFlow,
  type FlowBackend,
  type FlowDefinition,
  type FlowRunResult,
  type FlowTemplate,
  type FlowTrigger,
} from "@lacrew/flows";
import { runMcpTool, type McpToolBackend } from "@lacrew/adapter-agents-mcp";
import { createFlowStoreFromEnv, type FlowStore } from "./flowStore.js";
import type { ModelProvider } from "./model/index.js";
import type { CrewRuntime } from "./runtime.js";

const RUN_RING_MAX = 50;
/** Cron scheduler poll cadence — fine for minute-resolution schedules. */
const CRON_POLL_MS = 20_000;

export type FlowsSurface = {
  list(): FlowDefinition[];
  save(def: FlowDefinition): Promise<FlowDefinition>;
  remove(id: string): Promise<boolean>;
  run(input: {
    id?: string;
    flow?: FlowDefinition;
    input?: string;
    trigger?: FlowTrigger;
  }): Promise<FlowRunResult>;
  runs(): FlowRunResult[];
  templates(): FlowTemplate[];
  /** Run every saved flow with the given trigger (queue epoch hook). */
  runTriggered(trigger: FlowTrigger): Promise<FlowRunResult[]>;
  /** Run cron-triggered flows whose schedule matches `now` (once per minute). */
  runCronDue(now?: Date): Promise<FlowRunResult[]>;
  /** Start/stop the minute-resolution cron scheduler (idempotent). */
  startCron(): void;
  stopCron(): void;
  /** Load persisted definitions + recent runs; returns counts for boot logs. */
  hydrate(): Promise<{ flows: number; runs: number }>;
  storeName: string;
};

export function createFlowsSurface(opts: {
  runtime: CrewRuntime;
  model: ModelProvider;
  /** Live MCP backend; omitted (LACREW_MCP_MOCK=1) falls back to the detached mock. */
  mcpBackend?: McpToolBackend;
  store?: FlowStore;
}): FlowsSurface {
  const store = opts.store ?? createFlowStoreFromEnv();
  const flows = new Map<string, FlowDefinition>();
  const runRing: FlowRunResult[] = [];
  const cronFiredAt = new Map<string, number>();
  let cronTimer: NodeJS.Timeout | null = null;
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

  const pushRun = (result: FlowRunResult): void => {
    runRing.push(result);
    if (runRing.length > RUN_RING_MAX) runRing.splice(0, runRing.length - RUN_RING_MAX);
    // Fire-and-forget; the store swallows its own errors.
    void store.appendRun(result);
  };

  const runOne = async (input: {
    id?: string;
    flow?: FlowDefinition;
    input?: string;
    trigger?: FlowTrigger;
  }): Promise<FlowRunResult> => {
    const def =
      input.flow ??
      flows.get(input.id ?? "") ??
      flowTemplates.find((t) => t.definition.id === input.id)?.definition;
    if (!def) throw new Error("flow_not_found");
    const result = await runFlow(def, backend, {
      input: input.input,
      trigger: input.trigger,
      mocked,
    });
    pushRun(result);
    opts.runtime.recordAudit({
      type: "FlowRun",
      at: result.finishedAt,
      payload: {
        flowId: result.flowId,
        runId: result.runId,
        status: result.status,
        trigger: result.trigger ?? "manual",
        steps: result.steps.length,
        verdicts: result.steps.filter((s) => s.verdict).map((s) => s.verdict),
        mocked: result.mocked ?? false,
      },
    });
    return result;
  };

  const surface: FlowsSurface = {
    list: () => [...flows.values()],
    save: async (def) => {
      const check = validateFlow(def);
      if (!check.ok) throw new Error(`invalid_flow: ${check.errors.join("; ")}`);
      flows.set(def.id, structuredClone(def));
      await store.save(def);
      opts.runtime.recordAudit({
        type: "FlowSaved",
        at: new Date().toISOString(),
        payload: {
          flowId: def.id,
          name: def.name,
          steps: def.steps.length,
          trigger: def.trigger ?? "manual",
        },
      });
      return def;
    },
    remove: async (id) => {
      const existed = flows.delete(id);
      if (existed) await store.remove(id);
      return existed;
    },
    run: runOne,
    runs: () => [...runRing].reverse(),
    templates: () => flowTemplates,
    runCronDue: async (now = new Date()) => {
      const minuteKey = Math.floor(now.getTime() / 60_000);
      const results: FlowRunResult[] = [];
      for (const def of flows.values()) {
        if (def.trigger !== "cron" || !def.schedule) continue;
        if (!cronMatches(def.schedule, now)) continue;
        if (cronFiredAt.get(def.id) === minuteKey) continue;
        cronFiredAt.set(def.id, minuteKey);
        try {
          results.push(await runOne({ id: def.id, trigger: "cron" }));
        } catch (err) {
          console.error(`[@lacrew/orchestrator] cron flow "${def.id}" failed:`, err);
        }
      }
      return results;
    },
    startCron: () => {
      if (cronTimer) return;
      cronTimer = setInterval(() => {
        void surface.runCronDue();
      }, CRON_POLL_MS);
      cronTimer.unref?.();
    },
    stopCron: () => {
      if (cronTimer) clearInterval(cronTimer);
      cronTimer = null;
    },
    runTriggered: async (trigger) => {
      const due = [...flows.values()].filter((f) => (f.trigger ?? "manual") === trigger);
      const results: FlowRunResult[] = [];
      for (const def of due) {
        try {
          results.push(await runOne({ id: def.id, trigger }));
        } catch (err) {
          console.error(`[@lacrew/orchestrator] ${trigger} flow "${def.id}" failed:`, err);
        }
      }
      return results;
    },
    hydrate: async () => {
      for (const def of await store.list()) flows.set(def.id, def);
      const persisted = await store.recentRuns(RUN_RING_MAX);
      // recentRuns is newest → oldest; the ring wants oldest first.
      for (const run of [...persisted].reverse()) runRing.push(run);
      return { flows: flows.size, runs: runRing.length };
    },
    storeName: store.name,
  };
  return surface;
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
