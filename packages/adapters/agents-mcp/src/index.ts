/**
 * MCP tool adapter for agent frameworks (PRD F1.9).
 * Exposes LaCrew tools over a minimal JSON-RPC stdio MCP server (no SDK vendor lock).
 * Tools dispatch to an injected McpToolBackend (the orchestrator passes its live
 * runtime); without one they fall back to a detached SDK mock client.
 */

import { createInterface } from "node:readline";
import { createLacrewClient } from "@lacrew/sdk/testing";

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

  /**
   * Crew-driving surface. Optional because a detached mock SDK client cannot
   * reach governance or the treasury — `runMcpTool` reports that plainly
   * rather than pretending the call succeeded.
   */
  checkPolicy?(input: {
    agent: `0x${string}`;
    target: `0x${string}`;
    value: bigint;
    data?: `0x${string}`;
  }): Promise<{ verdict: string }>;
  orgAction?(input: OrgActionInput): Promise<unknown>;
  setBudget?(input: BudgetActionInput): Promise<unknown>;
  governance?(input: GovernanceActionInput): Promise<unknown>;
  invokeAgent?(input: { agent: `0x${string}`; prompt?: string; flowId?: string }): Promise<unknown>;
  /** Conversation (F1.7). Posting is a claim, never an authority. */
  postMessage?(input: {
    thread: string;
    body: string;
    kind?: string;
    options?: string[];
    to?: string;
    refs?: Array<{ kind: string; id: string }>;
    blocks?: unknown[];
  }): Promise<unknown>;
  readThread?(input: { thread: string; limit?: number }): Promise<unknown>;
}

export type OrgActionInput = {
  action:
    | "hire"
    | "fire"
    | "reparent"
    | "activate"
    | "deactivate"
    | "set-cap"
    | "set-whitelist"
    | "set-policy";
  node?: `0x${string}`;
  /** Display name for the node "hire" mints. */
  label?: string;
  parent?: `0x${string}`;
  nodeKind?: "manager_agent" | "worker_agent";
  cap?: bigint;
  target?: `0x${string}`;
  allowed?: boolean;
};

export type BudgetActionInput = {
  action: "set-grant" | "stream-allowance" | "run-epoch";
  node?: `0x${string}`;
  amount?: bigint;
};

export type GovernanceActionInput = {
  action: "propose" | "vote" | "veto" | "execute";
  proposalId?: string;
  support?: boolean;
  tier?: "low" | "high";
  target?: `0x${string}`;
  data?: `0x${string}`;
};

export interface RunMcpToolOptions {
  /** Live backend; takes precedence over everything else. */
  backend?: McpToolBackend;
  /**
   * Opt in to the detached demo client from `@lacrew/sdk/testing`.
   *
   * Must be set explicitly. There is no default backend: with no `backend` and
   * no `useMock: true`, a tool call throws rather than answering from the
   * sample org.
   */
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
    {
      name: "lacrew_check_policy",
      description:
        "Read the policy verdict (ALLOW | ESCALATE | DENY) for an action without proposing it.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          target: { type: "string" },
          value: { type: "string", description: "uint256 as decimal string" },
          data: { type: "string", description: "0x calldata" },
        },
        required: ["agent", "target", "value"],
      },
    },
    {
      name: "lacrew_org_action",
      description:
        "Change the org chart or an agent's properties. Always routed through governance (org structure is constitutional); the policy verdict picks the tier — ALLOW earns low tier, ESCALATE high tier with timelock, DENY raises nothing.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "hire",
              "fire",
              "reparent",
              "activate",
              "deactivate",
              "set-cap",
              "set-whitelist",
              "set-policy",
            ],
          },
          node: { type: "string" },
          label: { type: "string" },
          parent: { type: "string" },
          nodeKind: { type: "string", enum: ["manager_agent", "worker_agent"] },
          cap: { type: "string", description: "uint256 as decimal string" },
          target: { type: "string" },
          allowed: { type: "boolean" },
        },
        required: ["action"],
      },
    },
    {
      name: "lacrew_set_budget",
      description:
        "Raise a node's per-epoch grant, stream an allowance now, or run the next epoch. Grants and streams route through governance on the same verdict-picks-tier rule as lacrew_org_action; run-epoch writes directly (the orchestrator is the EpochStreamer operator).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set-grant", "stream-allowance", "run-epoch"] },
          node: { type: "string" },
          amount: { type: "string", description: "uint256 as decimal string" },
        },
        required: ["action"],
      },
    },
    {
      name: "lacrew_governance",
      description:
        "Act on the GovernanceModule: raise a proposal, vote, veto, or execute a ripe one.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["propose", "vote", "veto", "execute"] },
          proposalId: { type: "string" },
          support: { type: "boolean" },
          tier: { type: "string", enum: ["low", "high"] },
          target: { type: "string" },
          data: { type: "string", description: "0x calldata" },
        },
        required: ["action"],
      },
    },
    {
      name: "lacrew_invoke_agent",
      description:
        "Delegate to another agent: hand it a prompt, or run a flow as that agent. The delegate runs under its own policy stack.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          prompt: { type: "string" },
          flowId: { type: "string" },
        },
        required: ["agent"],
      },
    },
    /*
      Conversation (F1.7). These are the tools that let a crew work the way a
      person expects a collaborator to: say what it is about to do before doing
      it, ask when it does not know, and report what happened afterwards.

      None of them grant anything. A plan posted here is not an approval to
      execute it, and an answer is not authorization — the spend still meets the
      policy stack. The descriptions say so, because a model reading a tool list
      will otherwise infer that announcing an action is part of taking it.
    */
    {
      name: "lacrew_say",
      description:
        "Post to a thread the humans and other agents can read: a crew channel, another agent, or the org. Use kind 'plan' before you act so a human can redirect you, 'result' after, 'handoff' when passing work on, 'note' otherwise. Attach refs (intent id, proposal id, tx hash) to anything you claim happened, so it can be checked. Posting grants no permission: a plan is not an approval, and the action still goes through policy.",
      inputSchema: {
        type: "object",
        properties: {
          thread: {
            type: "string",
            description: "crew:<id>, agent:<address>, or org",
          },
          kind: {
            type: "string",
            enum: ["note", "plan", "result", "handoff"],
          },
          body: { type: "string" },
          to: { type: "string", description: "Who this is directed at (optional)" },
          blocks: {
            type: "array",
            description:
              "Rich content. {kind:'text'|'code',text} for prose or output, {kind:'fields',items:[{label,value}]} for what you found, {kind:'link',url,label} for something off-site you produced or read, {kind:'ref',ref:'intent'|'proposal'|'tx'|'flowRun',id} to point at something in LaCrew. A ref carries ONLY what it points at — the surface renders its summary and any control from the real record, so do not describe it here.",
            items: { type: "object" },
          },
          refs: {
            type: "array",
            description: "What this claims to be about, so a reader can verify it",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["intent", "proposal", "tx", "flowRun"] },
                id: { type: "string" },
              },
              required: ["kind", "id"],
            },
          },
        },
        required: ["thread", "body"],
      },
    },
    {
      name: "lacrew_ask",
      description:
        "Ask a question in a thread and offer the options you see. The question stays open until someone answers it — this does not block you, so say in the body what you will do meanwhile, or stop and wait. Use it when a choice is genuinely the human's to make rather than guessing.",
      inputSchema: {
        type: "object",
        properties: {
          thread: { type: "string" },
          body: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["thread", "body"],
      },
    },
    {
      name: "lacrew_read_thread",
      description:
        "Read a thread oldest-first, with the questions in it that nobody has answered. Read before you ask: the answer may already be there.",
      inputSchema: {
        type: "object",
        properties: {
          thread: { type: "string" },
          limit: { type: "number" },
        },
        required: ["thread"],
      },
    },
  ];
}

/**
 * Backend that proxies tool calls to a running orchestrator's HTTP MCP
 * surface — the stdio server uses this when ORCH_URL is set, so Cursor /
 * Claude Desktop reach the live runtime (session-signed onchain calls)
 * instead of a detached mock. Token pairs with LACREW_ORCH_TOKEN.
 */
export function createOrchHttpMcpBackend(baseUrl: string, token?: string): McpToolBackend {
  const base = baseUrl.replace(/\/$/, "");
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const res = await fetch(`${base}/mcp/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name, arguments: args }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`orchestrator_mcp_${res.status}: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { result?: unknown };
    return body.result;
  };

  return {
    getOrgTree: () => call("lacrew_get_org_tree", {}),
    listPendingIntents: async () => (await call("lacrew_list_pending_intents", {})) as unknown[],
    proposeIntent: (input) =>
      call("lacrew_propose_intent", {
        agent: input.agent,
        target: input.target,
        value: input.value.toString(),
      }),
    resolveIntent: (intentId, approved) => call("lacrew_approve_intent", { intentId, approved }),
    checkPolicy: async (input) =>
      (await call("lacrew_check_policy", {
        agent: input.agent,
        target: input.target,
        value: input.value.toString(),
        ...(input.data ? { data: input.data } : {}),
      })) as { verdict: string },
    orgAction: (input) =>
      call("lacrew_org_action", {
        ...input,
        ...(input.cap === undefined ? {} : { cap: input.cap.toString() }),
      }),
    setBudget: (input) =>
      call("lacrew_set_budget", {
        ...input,
        ...(input.amount === undefined ? {} : { amount: input.amount.toString() }),
      }),
    governance: (input) => call("lacrew_governance", { ...input }),
    invokeAgent: (input) => call("lacrew_invoke_agent", { ...input }),
    postMessage: (input) => call("lacrew_say", { ...input }),
    readThread: (input) => call("lacrew_read_thread", { ...input }),
  };
}

/** Detached SDK client backend. Demo data only when `useMock: true`. */
export function createSdkMcpBackend(opts: { useMock?: boolean } = {}): McpToolBackend {
  const client = createLacrewClient({ useMock: opts.useMock ?? false });
  return {
    getOrgTree: () => client.getOrgTree(),
    listPendingIntents: () => client.getPendingIntents(),
    proposeIntent: (input) => client.proposeIntent(input),
    resolveIntent: (intentId, approved) => client.resolveIntent(intentId, approved),
  };
}

/**
 * The backend a tool call runs against.
 *
 * There is no default. The demo client used to be one, so any of the framework
 * adapters called with no arguments — the documented entry points — returned
 * tools that served the sample org tree and accepted proposes and approvals.
 * A model reported an approved spend that had never touched a chain, and
 * nothing in the payload said otherwise. Going live must not be the opt-in.
 */
export function resolveMcpBackend(opts: RunMcpToolOptions = {}): McpToolBackend {
  if (opts.backend) return opts.backend;
  if (opts.useMock === true) return createSdkMcpBackend({ useMock: true });
  throw new Error(
    "No LaCrew backend configured. Pass `backend` (an orchestrator URL, or ORCH_URL for the stdio server) to run against a chain, or `useMock: true` for the detached demo client.",
  );
}

/** Tool runner; dispatches to `opts.backend`, or an explicitly requested mock. */
export async function runMcpTool(
  name: string,
  args: Record<string, unknown>,
  opts: RunMcpToolOptions = {},
): Promise<unknown> {
  const backend = resolveMcpBackend(opts);

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
    case "lacrew_check_policy": {
      const fn = capability(backend, "checkPolicy", name);
      return fn({
        agent: String(args.agent) as `0x${string}`,
        target: String(args.target) as `0x${string}`,
        value: BigInt(String(args.value ?? "0")),
        ...(args.data ? { data: String(args.data) as `0x${string}` } : {}),
      });
    }
    case "lacrew_org_action": {
      const fn = capability(backend, "orgAction", name);
      return fn({
        action: String(args.action) as OrgActionInput["action"],
        ...(args.node ? { node: String(args.node) as `0x${string}` } : {}),
        ...(args.label ? { label: String(args.label) } : {}),
        ...(args.parent ? { parent: String(args.parent) as `0x${string}` } : {}),
        ...(args.nodeKind ? { nodeKind: args.nodeKind as OrgActionInput["nodeKind"] } : {}),
        ...(args.cap === undefined ? {} : { cap: BigInt(String(args.cap)) }),
        ...(args.target ? { target: String(args.target) as `0x${string}` } : {}),
        ...(args.allowed === undefined ? {} : { allowed: Boolean(args.allowed) }),
      });
    }
    case "lacrew_set_budget": {
      const fn = capability(backend, "setBudget", name);
      return fn({
        action: String(args.action) as BudgetActionInput["action"],
        ...(args.node ? { node: String(args.node) as `0x${string}` } : {}),
        ...(args.amount === undefined ? {} : { amount: BigInt(String(args.amount)) }),
      });
    }
    case "lacrew_governance": {
      const fn = capability(backend, "governance", name);
      return fn({
        action: String(args.action) as GovernanceActionInput["action"],
        ...(args.proposalId ? { proposalId: String(args.proposalId) } : {}),
        ...(args.support === undefined ? {} : { support: Boolean(args.support) }),
        ...(args.tier ? { tier: args.tier as GovernanceActionInput["tier"] } : {}),
        ...(args.target ? { target: String(args.target) as `0x${string}` } : {}),
        ...(args.data ? { data: String(args.data) as `0x${string}` } : {}),
      });
    }
    case "lacrew_invoke_agent": {
      const fn = capability(backend, "invokeAgent", name);
      return fn({
        agent: String(args.agent) as `0x${string}`,
        ...(args.prompt ? { prompt: String(args.prompt) } : {}),
        ...(args.flowId ? { flowId: String(args.flowId) } : {}),
      });
    }
    case "lacrew_say":
    case "lacrew_ask": {
      const fn = capability(backend, "postMessage", name);
      return fn({
        thread: String(args.thread),
        body: String(args.body),
        // `lacrew_ask` is `lacrew_say` with the kind fixed, so an agent cannot
        // ask a question that files itself as a note and never gets answered.
        kind: name === "lacrew_ask" ? "question" : String(args.kind ?? "note"),
        ...(Array.isArray(args.options) ? { options: args.options.map(String) } : {}),
        ...(args.to ? { to: String(args.to) } : {}),
        ...(Array.isArray(args.blocks) ? { blocks: args.blocks } : {}),
        ...(Array.isArray(args.refs)
          ? {
              refs: (args.refs as Array<{ kind?: unknown; id?: unknown }>)
                .filter((r) => r?.id)
                .map((r) => ({ kind: String(r.kind ?? "intent"), id: String(r.id) })),
            }
          : {}),
      });
    }
    case "lacrew_read_thread": {
      const fn = capability(backend, "readThread", name);
      return fn({
        thread: String(args.thread),
        ...(args.limit ? { limit: Number(args.limit) } : {}),
      });
    }
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

/**
 * Resolve an optional backend capability, bound to its backend. Missing
 * capabilities fail loudly: a detached mock must never look like it moved
 * money or changed the org.
 */
function capability<K extends keyof McpToolBackend>(
  backend: McpToolBackend,
  key: K,
  tool: string,
): NonNullable<McpToolBackend[K]> {
  const fn = backend[key];
  if (typeof fn !== "function") {
    throw new Error(`${tool} is not supported by this backend (no ${String(key)})`);
  }
  return fn.bind(backend) as NonNullable<McpToolBackend[K]>;
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
export async function startLacrewMcpStdioServer(opts: RunMcpToolOptions = {}): Promise<void> {
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
