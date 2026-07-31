/**
 * `lacrew mcp …` — attached third-party MCP servers and the tools they are
 * allowed to offer a crew (F2.30).
 *
 * Every subcommand talks to a running orchestrator, because the allowlist is
 * deployment state: which servers are attached comes from that process's
 * configuration, and which of their tools an operator admitted lives in its
 * store. There is no offline half to this the way there is for skill packs.
 *
 * The verbs are deliberately `allow` / `deny` / `clear` rather than a single
 * `set`: admitting a third party's tool is the one action here that changes
 * what a crew can do, and it should read like a decision at the point it is
 * typed.
 */

type ToolView = {
  name: string;
  description?: string;
  enabled: boolean;
  effect: "read" | "write";
  mode: "auto" | "ask" | "deny";
  present: boolean;
  source: { kind: string; scope?: { level: string; ref?: string } };
};

type ServerView = {
  id: string;
  title?: string;
  transport: "http" | "stdio";
  endpoint: string;
  auth: { kind: string; envVars: string[]; ready: boolean };
  tools: ToolView[];
  blockedCount: number;
  lastRefreshAt?: string;
  lastRefreshError?: string;
};

type RefreshResult = {
  server: string;
  ok: boolean;
  added: string[];
  removed: string[];
  unchanged: string[];
  error?: string;
};

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

function orchUrl(args: string[]): string {
  return (flagValue(args, "--url") ?? process.env.ORCH_URL ?? "http://127.0.0.1:8788").replace(
    /\/$/,
    "",
  );
}

async function orchFetch<T>(args: string[], path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.ORCH_TOKEN?.trim();
  const res = await fetch(`${orchUrl(args)}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** `<server>.<tool>` — the shape every allow/deny/clear takes. */
export function parseToolRef(raw: string | undefined): { server: string; tool: string } {
  const dot = raw?.indexOf(".") ?? -1;
  if (!raw || dot <= 0) {
    throw new Error(`Name the tool as <server>.<tool> (got ${raw ?? "nothing"}).`);
  }
  return { server: raw.slice(0, dot), tool: raw.slice(dot + 1) };
}

/** `--scope crew:0x… | agent:0x… | workspace` (default workspace). */
export function parseScope(raw: string | undefined): { level: string; ref?: string } {
  if (!raw || raw === "workspace") return { level: "workspace" };
  const [level, ref] = raw.split(":");
  if ((level !== "crew" && level !== "agent") || !ref) {
    throw new Error(`--scope takes workspace, crew:0x…, or agent:0x… (got ${raw}).`);
  }
  return { level, ref };
}

function printServers(servers: ServerView[]): void {
  if (servers.length === 0) {
    console.log("No external MCP server is attached. Set LACREW_MCP_SERVERS on the orchestrator.");
    return;
  }
  for (const server of servers) {
    console.log(
      `\n${server.title ?? server.id}  [${server.id}]  ${server.transport}  ${server.endpoint}`,
    );
    const creds = server.auth.envVars.length
      ? `${server.auth.envVars.join(", ")} ${server.auth.ready ? "✓ set" : "✗ missing"}`
      : "no credential";
    console.log(`  auth: ${server.auth.kind} (${creds})`);
    if (server.lastRefreshError) {
      console.log(`  ⚠ last refresh failed: ${server.lastRefreshError} — this list may be stale`);
    }
    if (server.tools.length === 0) {
      console.log("  no tools discovered yet — try: lacrew mcp refresh");
      continue;
    }
    for (const tool of server.tools) {
      const state = tool.enabled ? "allowed" : "blocked";
      const mode = tool.effect === "write" ? ` ${tool.mode}` : "";
      const gone = tool.present ? "" : "  (no longer on the server)";
      console.log(`  ${tool.enabled ? "●" : "○"} ${tool.name}  ${tool.effect}${mode}  ${state}${gone}`);
      if (tool.description) console.log(`      ${tool.description}`);
    }
    if (server.blockedCount > 0) {
      console.log(`  ${server.blockedCount} tool(s) blocked until allowed by name.`);
    }
  }
}

function printRefresh(results: RefreshResult[]): void {
  for (const result of results) {
    if (!result.ok) {
      console.log(`${result.server}: unreachable — ${result.error}. The allowlist is unchanged.`);
      continue;
    }
    const total = result.added.length + result.unchanged.length;
    console.log(`${result.server}: ${total} tool(s)`);
    if (result.added.length > 0) {
      // Said this way on purpose: a refresh never widens anything, and the
      // operator's next move is to allow one by name if they mean to.
      console.log(`  new and blocked: ${result.added.join(", ")}`);
    }
    if (result.removed.length > 0) {
      console.log(`  gone from the server: ${result.removed.join(", ")}`);
    }
  }
}

export async function cmdMcp(args: string[]): Promise<void> {
  const [sub = "help", ...rest] = args;

  if (sub === "servers" || sub === "list") {
    const as = flagValue(args, "--as");
    const body = await orchFetch<{ servers: ServerView[] }>(
      args,
      `/mcp/servers${as ? `?as=${encodeURIComponent(as)}` : ""}`,
    );
    printServers(body.servers);
    return;
  }

  if (sub === "refresh") {
    const server = rest[0]?.startsWith("-") ? undefined : rest[0];
    const body = await orchFetch<{ results: RefreshResult[] }>(args, "/mcp/servers/refresh", {
      method: "POST",
      body: JSON.stringify(server ? { server } : {}),
    });
    printRefresh(body.results);
    return;
  }

  if (sub === "ping") {
    const server = rest[0];
    if (!server) throw new Error("lacrew mcp ping <server>");
    const body = await orchFetch<{ ok: boolean; ms: number; tools?: number; error?: string }>(
      args,
      "/mcp/servers/ping",
      { method: "POST", body: JSON.stringify({ server }) },
    );
    console.log(
      body.ok
        ? `${server}: reachable in ${body.ms}ms, ${body.tools} tool(s) published.`
        : `${server}: unreachable after ${body.ms}ms — ${body.error}`,
    );
    return;
  }

  if (sub === "allow" || sub === "deny" || sub === "clear") {
    const { server, tool } = parseToolRef(rest[0]);
    const scope = parseScope(flagValue(args, "--scope"));
    const effect = flagValue(args, "--effect");
    const mode = flagValue(args, "--mode");

    if (sub === "clear") {
      const body = await orchFetch<{ cleared: boolean }>(args, "/mcp/servers/tools", {
        method: "PUT",
        body: JSON.stringify({ scope, server, tool }),
      });
      console.log(
        body.cleared
          ? `Cleared the rule on ${server}.${tool} at ${scope.level} scope — it inherits again.`
          : `No rule on ${server}.${tool} at ${scope.level} scope. Nothing changed.`,
      );
      return;
    }

    const enabled = sub === "allow";
    await orchFetch(args, "/mcp/servers/tools", {
      method: "PUT",
      body: JSON.stringify({
        scope,
        server,
        tool,
        enabled,
        ...(effect ? { effect } : {}),
        ...(mode ? { mode } : {}),
      }),
    });
    if (enabled) {
      console.log(
        `Allowed ${server}.${tool}${effect ? ` (${effect})` : ""}${mode ? ` in ${mode} mode` : ""} ` +
          `at ${scope.level} scope.`,
      );
      console.log(
        "This admits one third-party tool. It changes no cap, whitelist, session scope or policy.",
      );
    } else {
      console.log(`Blocked ${server}.${tool} at ${scope.level} scope.`);
    }
    return;
  }

  console.log(`lacrew mcp — attached MCP servers and their allowlist (F2.30)

Against a running orchestrator (ORCH_URL / --url, token via ORCH_TOKEN):
  servers [--as 0x…]        Attached servers and every tool's state
  refresh [server]          Re-read tool lists; new tools are recorded blocked
  ping <server>             Reachability check, with how many tools it publishes
  allow <server>.<tool>     Admit one tool
  deny <server>.<tool>      Block one tool (or <server>.* for the whole server)
  clear <server>.<tool>     Drop the rule at that scope so the tool inherits

Flags:
  --scope workspace | crew:0x… | agent:0x…   Where the rule applies (default workspace)
  --effect read | write     Classify the tool (workspace scope only; unset means write)
  --mode auto | ask | deny  Write mode; a read carries none
  --as 0x…                  Resolve the listing for one seat
  --url <base>              Orchestrator base URL

A tool is refused until it is allowed by name, and a tool that appears on a
server after registration starts blocked — including one added between two
refreshes. A wildcard may only narrow: <server>.* can deny, never admit.

Env:
  ORCH_URL     Orchestrator base URL (default http://127.0.0.1:8788)
  ORCH_TOKEN   Bearer token (pairs with LACREW_ORCH_TOKEN)`);
}
