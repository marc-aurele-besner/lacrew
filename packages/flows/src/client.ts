import type { FlowDefinition, FlowRunResult, FlowTemplate } from "./types.js";

export type FlowsClientOptions = {
  /** Orchestrator base URL, e.g. http://127.0.0.1:8788 */
  baseUrl: string;
  /** Pairs with the orchestrator's LACREW_ORCH_TOKEN bearer auth. */
  token?: string;
  fetchImpl?: typeof fetch;
};

export type FlowsClient = {
  list(): Promise<FlowDefinition[]>;
  save(def: FlowDefinition): Promise<FlowDefinition>;
  remove(id: string): Promise<void>;
  run(id: string, opts?: { input?: string }): Promise<FlowRunResult>;
  /** Run an unsaved definition directly (the builder's dry-run path). */
  runDefinition(def: FlowDefinition, opts?: { input?: string }): Promise<FlowRunResult>;
  runs(): Promise<FlowRunResult[]>;
  templates(): Promise<FlowTemplate[]>;
};

/** Typed HTTP client for the orchestrator's /flows surface (code-first path). */
export function createFlowsClient(opts: FlowsClientOptions): FlowsClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;

  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`flows_http_${res.status}: ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  };

  return {
    list: async () => (await call<{ flows: FlowDefinition[] }>("/flows")).flows,
    save: async (def) =>
      (await call<{ flow: FlowDefinition }>("/flows", {
        method: "POST",
        body: JSON.stringify({ flow: def }),
      })).flow,
    remove: async (id) => {
      await call("/flows/delete", { method: "POST", body: JSON.stringify({ id }) });
    },
    run: (id, runOpts) =>
      call<FlowRunResult>("/flows/run", {
        method: "POST",
        body: JSON.stringify({ id, input: runOpts?.input }),
      }),
    runDefinition: (def, runOpts) =>
      call<FlowRunResult>("/flows/run", {
        method: "POST",
        body: JSON.stringify({ flow: def, input: runOpts?.input }),
      }),
    runs: async () => (await call<{ runs: FlowRunResult[] }>("/flows/runs")).runs,
    templates: async () =>
      (await call<{ templates: FlowTemplate[] }>("/flows/templates")).templates,
  };
}
