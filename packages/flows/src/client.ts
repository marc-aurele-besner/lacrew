import type { FlowDefinition, FlowRunResult, FlowTemplate } from "./types.js";

/**
 * Wire shapes for the orchestrator's `/flows/triggers*` surface (F2.22).
 *
 * Declared structurally here rather than imported from `@lacrew/orchestrator`:
 * this package is the chain-free client the code-first path uses, and depending
 * on the orchestrator would invert that. The orchestrator owns the behaviour;
 * these are the fields it puts on the wire.
 */
export type FlowTriggerRecord = {
  id: string;
  flowId: string;
  principal?: string;
  /** Event source: `lacrew` | `github` | `google-pubsub`. */
  scheme: string;
  enabled: boolean;
  input?: { path?: string; fields?: Record<string, string> };
  description?: string;
  /** Event types subscribed to; absent means every delivery runs. */
  events?: string[];
  /** Non-secret per-source settings (Pub/Sub audience, service account). */
  config?: Record<string, string>;
  /** Absent for sources that authenticate the sender instead of sharing a key. */
  secretVersion?: number;
};

export type FlowTriggerDelivery = {
  triggerId: string;
  deliveryKey: string;
  result: string;
  reason?: string | null;
  runId?: string | null;
  bytes?: number | null;
  at: string;
};

export type FlowTriggerCreate = {
  flowId: string;
  principal?: string;
  scheme?: string;
  input?: { path?: string; fields?: Record<string, string> };
  description?: string;
  events?: string[];
  config?: Record<string, string>;
  secret?: string;
};

export type FlowsClientOptions = {
  /** Orchestrator base URL, e.g. http://127.0.0.1:8788 */
  baseUrl: string;
  /** Pairs with the orchestrator's LACREW_ORCH_TOKEN bearer auth. */
  token?: string;
  fetchImpl?: typeof fetch;
};

export type FlowsClient = {
  /** Every flow, or only those `as` is scoped to see. */
  list(opts?: { as?: string }): Promise<FlowDefinition[]>;
  save(def: FlowDefinition): Promise<FlowDefinition>;
  remove(id: string): Promise<void>;
  /** `as` is the agent the run executes as; it also picks the policy ceiling. */
  run(id: string, opts?: { input?: string; as?: string }): Promise<FlowRunResult>;
  /** Run an unsaved definition directly (the builder's dry-run path). */
  runDefinition(
    def: FlowDefinition,
    opts?: { input?: string; as?: string },
  ): Promise<FlowRunResult>;
  runs(): Promise<FlowRunResult[]>;
  templates(): Promise<FlowTemplate[]>;
  /** Registered webhook triggers. Never carries a secret. */
  listTriggers(): Promise<FlowTriggerRecord[]>;
  /**
   * Mint a trigger. The secret comes back exactly once and is not readable
   * again; sources that authenticate their sender return none at all.
   */
  createTrigger(
    input: FlowTriggerCreate,
  ): Promise<{ trigger: FlowTriggerRecord; secret?: string }>;
  rotateTriggerSecret(
    id: string,
    secret?: string,
  ): Promise<{ trigger: FlowTriggerRecord; secret?: string }>;
  setTriggerEnabled(id: string, enabled: boolean): Promise<FlowTriggerRecord>;
  removeTrigger(id: string): Promise<boolean>;
  triggerDeliveries(opts?: {
    triggerId?: string;
    limit?: number;
  }): Promise<FlowTriggerDelivery[]>;
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
    list: async (listOpts) =>
      (
        await call<{ flows: FlowDefinition[] }>(
          listOpts?.as ? `/flows?as=${encodeURIComponent(listOpts.as)}` : "/flows",
        )
      ).flows,
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
        body: JSON.stringify({ id, input: runOpts?.input, as: runOpts?.as }),
      }),
    runDefinition: (def, runOpts) =>
      call<FlowRunResult>("/flows/run", {
        method: "POST",
        body: JSON.stringify({ flow: def, input: runOpts?.input, as: runOpts?.as }),
      }),
    runs: async () => (await call<{ runs: FlowRunResult[] }>("/flows/runs")).runs,
    templates: async () =>
      (await call<{ templates: FlowTemplate[] }>("/flows/templates")).templates,
    listTriggers: async () =>
      (await call<{ triggers: FlowTriggerRecord[] }>("/flows/triggers")).triggers,
    createTrigger: (input) =>
      call<{ trigger: FlowTriggerRecord; secret?: string }>("/flows/triggers", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    rotateTriggerSecret: (id, secret) =>
      call<{ trigger: FlowTriggerRecord; secret?: string }>("/flows/triggers/rotate", {
        method: "POST",
        body: JSON.stringify(secret ? { id, secret } : { id }),
      }),
    setTriggerEnabled: async (id, enabled) =>
      (
        await call<{ trigger: FlowTriggerRecord }>("/flows/triggers/enabled", {
          method: "POST",
          body: JSON.stringify({ id, enabled }),
        })
      ).trigger,
    removeTrigger: async (id) =>
      (
        await call<{ removed?: boolean }>("/flows/triggers/delete", {
          method: "POST",
          body: JSON.stringify({ id }),
        })
      ).removed === true,
    triggerDeliveries: async (deliveryOpts) => {
      const params = new URLSearchParams();
      if (deliveryOpts?.triggerId) params.set("triggerId", deliveryOpts.triggerId);
      if (deliveryOpts?.limit) params.set("limit", String(deliveryOpts.limit));
      const query = params.toString();
      return (
        await call<{ deliveries: FlowTriggerDelivery[] }>(
          `/flows/triggers/deliveries${query ? `?${query}` : ""}`,
        )
      ).deliveries;
    },
  };
}
