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
import type { OrgNode } from "@lacrew/core";
import { createFlowStoreFromEnv, type FlowStore } from "./flowStore.js";
import { ceilingAgent, scopeOf, scopeSessionLimits, visibleTo } from "./flowScope.js";
import { createRuntimeMcpBackend } from "./mcpBackend.js";
import type { ModelProvider } from "./model/index.js";
import type { CrewRuntime } from "./runtime.js";

const RUN_RING_MAX = 50;
/** Cron scheduler poll cadence — fine for minute-resolution schedules. */
const CRON_POLL_MS = 20_000;
/**
 * How deep `agent` steps may nest flow runs. Cycle validation only covers edges
 * *within* one definition, so a flowId reference is unchecked by it; without a
 * bound, a flow that delegates back into itself takes the process down.
 */
const MAX_DELEGATION_DEPTH = 4;

export type FlowsSurface = {
  /** Every flow, or only those `as` may see when a principal is given. */
  list(as?: string): Promise<FlowDefinition[]>;
  save(def: FlowDefinition): Promise<FlowDefinition>;
  remove(id: string): Promise<boolean>;
  run(input: {
    id?: string;
    flow?: FlowDefinition;
    input?: string;
    trigger?: FlowTrigger;
    /** Agent the run executes as; defaults to the crew worker. */
    as?: `0x${string}`;
  }): Promise<FlowRunResult>;
  runs(): FlowRunResult[];
  templates(): FlowTemplate[];
  /** Run every saved flow with the given trigger (queue epoch hook). */
  runTriggered(trigger: FlowTrigger): Promise<FlowRunResult[]>;
  /** Run cron-triggered flows whose schedule matches `now` (once per minute). */
  runCronDue(now?: Date): Promise<FlowRunResult[]>;
  /**
   * Start/stop an in-process minute-resolution sweeper (idempotent), for
   * embedders driving flows without a QueueProvider. `startServer` schedules
   * the sweep on the queue instead — running both double-fires cron flows.
   */
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

  /** Cached org chart for scope resolution; refreshed lazily per call. */
  const orgNodes = async (): Promise<OrgNode[]> => {
    try {
      return (await opts.runtime.getClient().getOrgTree()) as OrgNode[];
    } catch {
      // No reachable registry (mock/detached): scoping cannot be evaluated.
      return [];
    }
  };

  /**
   * A backend bound to one run's identity. Gate defaults, the policy ceiling,
   * and delegation all follow the principal rather than the process-wide worker.
   */
  const backendFor = (
    principal: `0x${string}`,
    ceiling: `0x${string}` | undefined,
    sessionLimits: ReturnType<typeof scopeSessionLimits>,
    chain: string[],
  ): FlowBackend => {
    if (mocked) return createMockFlowBackend();
    const bound = createRuntimeMcpBackend(opts.runtime, {
      principal,
      ceiling,
      window: sessionLimits.window,
      rate: sessionLimits.rate,
      scopes: sessionLimits.scopes,
    });
    return {
      complete: (input) => opts.model.complete(input),
      callTool: async (name, args) => {
        if (name === "lacrew_invoke_agent") return delegate(args, chain);
        return runMcpTool(name, fillGateDefaults(name, args, principal, opts.runtime), {
          backend: bound,
        });
      },
    };
  };

  /**
   * Delegate to another agent: run `flowId` as that agent when given, else hand
   * the prompt to the model. The delegate's own policy stack applies because
   * the nested run gets its own principal — a flow cannot borrow authority by
   * invoking a more privileged agent.
   */
  const delegate = async (
    args: Record<string, unknown>,
    chain: string[],
  ): Promise<unknown> => {
    const agent = String(args.agent ?? "") as `0x${string}`;
    const flowId = args.flowId ? String(args.flowId) : undefined;
    if (flowId) {
      if (chain.includes(flowId)) {
        throw new Error(`flow_delegation_cycle: ${[...chain, flowId].join(" → ")}`);
      }
      if (chain.length >= MAX_DELEGATION_DEPTH) {
        throw new Error(
          `flow_delegation_too_deep: ${chain.length} levels (max ${MAX_DELEGATION_DEPTH})`,
        );
      }
      const result = await runOne(
        {
          id: flowId,
          input: args.prompt ? String(args.prompt) : undefined,
          as: agent,
        },
        chain,
      );
      if (result.status === "error") {
        // A delegate that failed must fail the delegating step. Returning the
        // failure as data would let the parent run report "completed".
        const cause = result.steps.find((s) => s.status === "error")?.error ?? result.status;
        throw new Error(`flow_delegate_failed (${flowId}): ${cause}`);
      }
      return {
        agent,
        runId: result.runId,
        status: result.status,
        text: result.steps.at(-1)?.summary ?? result.status,
      };
    }
    const completion = await opts.model.complete({
      system: `You are agent ${agent} in a LaCrew organization.`,
      prompt: String(args.prompt ?? ""),
    });
    return { agent, text: completion.text, model: completion.model };
  };

  const pushRun = (result: FlowRunResult): void => {
    runRing.push(result);
    if (runRing.length > RUN_RING_MAX) runRing.splice(0, runRing.length - RUN_RING_MAX);
    // Fire-and-forget; the store swallows its own errors.
    void store.appendRun(result);
  };

  const runOne = async (
    input: {
      id?: string;
      flow?: FlowDefinition;
      input?: string;
      trigger?: FlowTrigger;
      as?: `0x${string}`;
    },
    /** Flow ids already on the delegation stack; guards nested `agent` steps. */
    chain: string[] = [],
  ): Promise<FlowRunResult> => {
    const def =
      input.flow ??
      flows.get(input.id ?? "") ??
      flowTemplates.find((t) => t.definition.id === input.id)?.definition;
    if (!def) throw new Error("flow_not_found");

    const principal = input.as ?? opts.runtime.defaultAgent;
    if (input.as && !visibleTo(def, input.as, await orgNodes())) {
      throw new Error("flow_out_of_scope");
    }

    const result = await runFlow(
      def,
      backendFor(principal, ceilingAgent(def), scopeSessionLimits(def), [...chain, def.id]),
      {
      input: input.input,
      trigger: input.trigger,
      principal: { agent: principal },
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
        principal,
        scope: scopeOf(def),
        steps: result.steps.length,
        verdicts: result.steps.filter((s) => s.verdict).map((s) => s.verdict),
        mocked: result.mocked ?? false,
      },
    });
    return result;
  };

  const surface: FlowsSurface = {
    list: async (as) => {
      const all = [...flows.values()];
      if (!as) return all;
      const nodes = await orgNodes();
      return all.filter((def) => visibleTo(def, as, nodes));
    },
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
  principal: `0x${string}`,
  runtime: CrewRuntime,
): Record<string, unknown> {
  if (name !== "lacrew_propose_intent" && name !== "lacrew_check_policy") return args;
  return {
    // The run's principal, not the process-wide worker.
    agent: args.agent ?? principal,
    target: args.target ?? runtime.defaultSpendTarget,
    ...args,
    value: String(args.value ?? "0"),
  };
}
