/**
 * `McpClient` — talking to somebody else's MCP server (PRD F2.30).
 *
 * LaCrew already *serves* MCP: the nine `lacrew_*` tools are how an agent reads
 * the org chart and proposes an intent. This is the other direction. An
 * operator already runs MCP servers for GitHub, a browser, a database; without
 * a way to attach one, reaching those means writing a connector preset per SaaS
 * or pointing agents at a side channel that never meets the tool policy.
 *
 * Everything above this file talks to the `McpClient` interface — three methods,
 * no transport in sight — so `externalMcp.ts` can decide *whether* a call goes
 * out without knowing whether the far side is a subprocess or a URL. That split
 * is the reason the allowlist is testable against a fake with no sockets and no
 * child process, and the reason a second transport is a new adapter here rather
 * than an edit to the enforcement path.
 *
 * Two transports ship:
 *
 * - **http** — JSON-RPC over `POST`, the streamable-HTTP shape. A session id
 *   handed back by `initialize` is echoed on every later request, and an
 *   `text/event-stream` reply is read for its last `data:` frame, because
 *   servers are free to answer either way.
 * - **stdio** — a subprocess speaking newline-delimited JSON-RPC on its own
 *   stdin/stdout. Self-host territory: a subprocess is code execution on the
 *   worker, which is why the hosted plane admits HTTP first (see
 *   `apps/docs/content/external-mcp.md`).
 *
 * Both are bounded the same way, and the bounds are the point rather than
 * politeness: a per-request **timeout** so a hung server cannot hold a funded
 * run open, and a **response size cap** so a server — malicious, or merely
 * enthusiastic about a table dump — cannot push an unbounded body into this
 * process and from there into a model's context.
 *
 * Credentials are *named* here, never carried: a server config holds the env var
 * to read at call time, exactly as a connector does, so a config can be shown to
 * an operator, stored, or logged without leaking anything.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** A tool as its server describes it. `annotations` is the server's claim, not ours. */
export type McpDiscoveredTool = {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments, as published. Never trusted as policy. */
  inputSchema?: Record<string, unknown>;
  /**
   * The server's own hints (`readOnlyHint`, `destructiveHint`). Recorded when a
   * tool is first discovered so an operator classifying it has the server's
   * claim in front of them — and deliberately advisory: a server declaring
   * itself read-only is the party with the least right to be believed about it.
   */
  annotations?: Record<string, unknown>;
};

export type McpCallResult = {
  /** MCP content blocks, verbatim. Treated as untrusted text by every caller. */
  content: unknown;
  /** The server reported the call itself failed (`isError`), not the transport. */
  isError: boolean;
};

export interface McpClient {
  readonly serverId: string;
  readonly transport: "http" | "stdio";
  /** Everything the server currently offers. The allowlist is applied above. */
  listTools(): Promise<McpDiscoveredTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** Release the transport (kill a subprocess, drop a session). Idempotent. */
  close(): Promise<void>;
}

export const DEFAULT_MCP_TIMEOUT_MS = 20_000;
export const DEFAULT_MCP_MAX_RESPONSE_BYTES = 1_000_000;

/** MCP revision this client speaks; servers negotiate down from their own. */
const PROTOCOL_VERSION = "2024-11-05";

type JsonRpcResponse = {
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function rpcResult(raw: unknown, serverId: string): unknown {
  const message = raw as JsonRpcResponse | null;
  if (message?.error) {
    throw new Error(`mcp_server_error:${serverId}:${message.error.message ?? message.error.code}`);
  }
  return message?.result;
}

/** `tools/list` payload → descriptors, dropping entries with no usable name. */
function readToolList(result: unknown): McpDiscoveredTool[] {
  const tools = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((entry) => {
    const tool = (entry ?? {}) as Record<string, unknown>;
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) return [];
    return [
      {
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema && typeof tool.inputSchema === "object"
          ? { inputSchema: tool.inputSchema as Record<string, unknown> }
          : {}),
        ...(tool.annotations && typeof tool.annotations === "object"
          ? { annotations: tool.annotations as Record<string, unknown> }
          : {}),
      },
    ];
  });
}

function readCallResult(result: unknown): McpCallResult {
  const payload = (result ?? {}) as { content?: unknown; isError?: unknown };
  return { content: payload.content ?? null, isError: payload.isError === true };
}

export type HttpMcpClientOptions = {
  serverId: string;
  url: string;
  /** Constant headers the operator declared (an API version pin, a tenant id). */
  headers?: Record<string, string>;
  /** Resolved at call time from the environment; this client never stores one. */
  authHeader?: () => Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Read a response body under a byte cap.
 *
 * Streamed rather than `res.text()` so the cap is enforced *while* the body
 * arrives: a caller that only checks the length afterwards has already
 * allocated whatever the server chose to send.
 */
async function readCapped(res: Response, cap: number, serverId: string): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value?.byteLength ?? 0;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`mcp_response_too_large:${serverId}`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * A JSON-RPC reply out of one HTTP response, whichever way the server framed it.
 * An SSE stream carries the answer in its `data:` frames, so the last one that
 * parses is the result; anything else is read as plain JSON.
 */
function parseRpcBody(text: string, contentType: string): unknown {
  if (!contentType.includes("text/event-stream")) {
    return text ? (JSON.parse(text) as unknown) : null;
  }
  let last: unknown = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      last = JSON.parse(payload) as unknown;
    } catch {
      // A frame that is not JSON is not this protocol's business.
    }
  }
  return last;
}

export function createHttpMcpClient(opts: HttpMcpClientOptions): McpClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const cap = opts.maxResponseBytes ?? DEFAULT_MCP_MAX_RESPONSE_BYTES;
  let nextId = 0;
  let sessionId: string | undefined;
  let handshake: Promise<void> | undefined;

  const send = async (
    method: string,
    params: Record<string, unknown> | undefined,
    notification = false,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(opts.headers ?? {}),
          // Auth last so a constant header cannot shadow the credential.
          ...(opts.authHeader?.() ?? {}),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(notification ? {} : { id: ++nextId }),
          method,
          ...(params ? { params } : {}),
        }),
        signal: controller.signal,
        // The egress check covered the configured URL, not wherever a 3xx
        // points; following it would carry the credential to a host nobody
        // vetted. A redirect is reported as the server's status instead.
        redirect: "manual",
      });
      const session = res.headers.get("mcp-session-id");
      if (session) sessionId = session;
      if (!res.ok) {
        // Drained under the cap: an error body is still a body a hostile server
        // chose the size of.
        await readCapped(res, cap, opts.serverId).catch(() => "");
        throw new Error(`mcp_http_${res.status}:${opts.serverId}`);
      }
      if (notification) {
        await readCapped(res, cap, opts.serverId).catch(() => "");
        return null;
      }
      const text = await readCapped(res, cap, opts.serverId);
      return rpcResult(parseRpcBody(text, res.headers.get("content-type") ?? ""), opts.serverId);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Handshake once per client, and only once even under concurrent callers. */
  const ready = async (): Promise<void> => {
    handshake ??= (async () => {
      await send("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "lacrew-orchestrator", version: "0.0.0" },
      });
      await send("notifications/initialized", undefined, true).catch(() => {});
    })().catch((err: unknown) => {
      // A failed handshake must not be cached as done: the next call would
      // speak to a server that never initialized and read the refusal as the
      // tool's own answer.
      handshake = undefined;
      throw err;
    });
    return handshake;
  };

  return {
    serverId: opts.serverId,
    transport: "http",
    listTools: async () => {
      await ready();
      return readToolList(await send("tools/list", {}));
    },
    callTool: async (name, args) => {
      await ready();
      return readCallResult(await send("tools/call", { name, arguments: args }));
    },
    close: async () => {
      sessionId = undefined;
      handshake = undefined;
    },
  };
}

export type StdioMcpClientOptions = {
  serverId: string;
  command: string;
  args?: string[];
  /**
   * The child's entire environment. Built by the caller from named passthrough
   * vars — this client never hands a subprocess `process.env`, which would
   * deal a third-party binary every credential the orchestrator holds.
   */
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Injected in tests; defaults to `node:child_process.spawn`. */
  spawnImpl?: typeof spawn;
};

export function createStdioMcpClient(opts: StdioMcpClientOptions): McpClient {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const cap = opts.maxResponseBytes ?? DEFAULT_MCP_MAX_RESPONSE_BYTES;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let buffer = "";
  let nextId = 0;
  let handshake: Promise<void> | undefined;

  const failAll = (err: Error): void => {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  };

  const start = (): ChildProcessWithoutNullStreams => {
    if (child && child.exitCode === null && !child.killed) return child;
    const proc = spawnImpl(opts.command, opts.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      // Deliberately not `{...process.env, ...opts.env}`: an MCP server is
      // third-party code, and inheriting this process's environment would hand
      // it the session sealing key and every connector token.
      env: opts.env ?? {},
    }) as ChildProcessWithoutNullStreams;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > cap) {
        buffer = "";
        failAll(new Error(`mcp_response_too_large:${opts.serverId}`));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        const id = typeof message.id === "number" ? message.id : undefined;
        const waiter = id === undefined ? undefined : pending.get(id);
        if (!waiter || id === undefined) continue;
        pending.delete(id);
        try {
          waiter.resolve(rpcResult(message, opts.serverId));
        } catch (err) {
          waiter.reject(err as Error);
        }
      }
    });
    // Kept off the orchestrator's own stderr: a chatty server would otherwise
    // own the operator's logs, and the transcript is not ours to publish.
    proc.stderr.resume();
    proc.on("exit", (code) => {
      handshake = undefined;
      failAll(new Error(`mcp_server_exited:${opts.serverId}:${code ?? "signal"}`));
    });
    proc.on("error", (err) => {
      handshake = undefined;
      failAll(new Error(`mcp_spawn_failed:${opts.serverId}:${err.message}`));
    });
    child = proc;
    return proc;
  };

  const send = async (
    method: string,
    params: Record<string, unknown> | undefined,
    notification = false,
  ): Promise<unknown> => {
    const proc = start();
    const id = ++nextId;
    const line = `${JSON.stringify({
      jsonrpc: "2.0",
      ...(notification ? {} : { id }),
      method,
      ...(params ? { params } : {}),
    })}\n`;
    if (notification) {
      proc.stdin.write(line);
      return null;
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`mcp_timeout:${opts.serverId}:${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      proc.stdin.write(line);
    });
  };

  const ready = async (): Promise<void> => {
    handshake ??= (async () => {
      await send("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "lacrew-orchestrator", version: "0.0.0" },
      });
      await send("notifications/initialized", undefined, true).catch(() => {});
    })().catch((err: unknown) => {
      handshake = undefined;
      throw err;
    });
    return handshake;
  };

  return {
    serverId: opts.serverId,
    transport: "stdio",
    listTools: async () => {
      await ready();
      return readToolList(await send("tools/list", {}));
    },
    callTool: async (name, args) => {
      await ready();
      return readCallResult(await send("tools/call", { name, arguments: args }));
    },
    close: async () => {
      handshake = undefined;
      failAll(new Error(`mcp_client_closed:${opts.serverId}`));
      child?.kill();
      child = undefined;
      buffer = "";
    },
  };
}
