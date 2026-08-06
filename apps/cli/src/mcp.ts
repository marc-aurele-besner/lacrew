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
  origin?: "env" | "runtime";
  endpoint: string;
  auth: { kind: string; envVars: string[]; ready: boolean };
  tools: ToolView[];
  blockedCount: number;
  lastRefreshAt?: string;
  lastRefreshError?: string;
};

type EgressView = {
  hosted: boolean;
  allowHosts: string[];
  allowStdio: boolean;
  allowLoopback: boolean;
  allowEnv: string[];
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

/** All the flag occurrences, so `--arg a --arg b` builds a list. */
function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] && !args[i + 1]!.startsWith("-")) out.push(args[i + 1]!);
  }
  return out;
}

/**
 * The egress policy, said plainly.
 *
 * Printed above the server list rather than only on a refusal: "attach is
 * refused" reads as a bug until an operator knows the worker is hosted and
 * which hosts it was told to reach.
 */
function printEgress(egress: EgressView | undefined): void {
  if (!egress?.hosted) return;
  console.log(
    `Hosted worker: stdio ${egress.allowStdio ? "allowed" : "refused"}, ` +
      `hosts ${egress.allowHosts.length > 0 ? egress.allowHosts.join(", ") : "none allowed yet"}` +
      (egress.allowEnv.length > 0 ? `, credential env ${egress.allowEnv.join(", ")}` : ""),
  );
}

function printServers(servers: ServerView[]): void {
  if (servers.length === 0) {
    console.log(
      "No external MCP server is attached. Attach one with: lacrew mcp attach <id> --url https://…\n" +
        "(or set LACREW_MCP_SERVERS on the orchestrator for a config it re-reads at every boot).",
    );
    return;
  }
  for (const server of servers) {
    const origin = server.origin === "runtime" ? "  attached at runtime" : "";
    console.log(
      `\n${server.title ?? server.id}  [${server.id}]  ${server.transport}  ${server.endpoint}${origin}`,
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
      console.log(
        `  ${tool.enabled ? "●" : "○"} ${tool.name}  ${tool.effect}${mode}  ${state}${gone}`,
      );
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

/**
 * A server config out of flags.
 *
 * Credentials are named here exactly as they are in a boot config: `--token-env`
 * takes the *name* of an environment variable the orchestrator reads at call
 * time, never a token. A CLI that accepted the secret itself would put it in a
 * shell history and then in a request body, which is two places it does not
 * belong.
 */
export function buildServerConfig(id: string | undefined, args: string[]): Record<string, unknown> {
  if (!id) throw new Error("lacrew mcp attach <id> --url https://… | --command <bin>");
  // `--endpoint`, not `--url`: `--url` already names the orchestrator this
  // command talks to, and one flag meaning two different servers is a mistake
  // waiting to point a tenant's config at their own control plane.
  const url = flagValue(args, "--endpoint");
  const command = flagValue(args, "--command");
  if (!url && !command) {
    throw new Error("Name where the server is: --endpoint https://… or --command <bin>.");
  }
  const tokenEnv = flagValue(args, "--token-env");
  const header = flagValue(args, "--header");
  const headerEnv = flagValue(args, "--header-env");
  const passthrough = flagValues(args, "--env");
  return {
    id,
    transport: command ? "stdio" : "http",
    ...(flagValue(args, "--title") ? { title: flagValue(args, "--title") } : {}),
    ...(url ? { url } : {}),
    ...(command ? { command } : {}),
    ...(flagValues(args, "--arg").length > 0 ? { args: flagValues(args, "--arg") } : {}),
    ...(passthrough.length > 0 ? { env: passthrough } : {}),
    ...(tokenEnv
      ? { auth: { kind: "bearer", tokenEnv } }
      : header && headerEnv
        ? { auth: { kind: "header", header, valueEnv: headerEnv } }
        : {}),
  };
}

export async function cmdMcp(args: string[]): Promise<void> {
  const [sub = "help", ...rest] = args;

  if (sub === "servers" || sub === "list") {
    const as = flagValue(args, "--as");
    const body = await orchFetch<{ servers: ServerView[]; egress?: EgressView }>(
      args,
      `/mcp/servers${as ? `?as=${encodeURIComponent(as)}` : ""}`,
    );
    printEgress(body.egress);
    printServers(body.servers);
    return;
  }

  if (sub === "attach") {
    const id = rest[0]?.startsWith("-") ? undefined : rest[0];
    const json = flagValue(args, "--json");
    // `--json` is the whole config, for a server whose shape outgrows flags
    // (constant headers, a response cap). The flags cover the common two.
    const server = json
      ? (JSON.parse(json) as Record<string, unknown>)
      : buildServerConfig(id, args);
    const body = await orchFetch<{
      server: ServerView;
      refresh: { added: string[]; ok: boolean; error?: string };
    }>(args, "/mcp/servers/attach", { method: "POST", body: JSON.stringify({ server }) });
    console.log(
      `Attached ${body.server.id} (${body.server.transport}) → ${body.server.endpoint}. ` +
        "No restart needed.",
    );
    if (!body.refresh.ok) {
      console.log(`  ⚠ it did not answer: ${body.refresh.error}. Nothing is callable yet.`);
    } else if (body.refresh.added.length > 0) {
      // The line that matters: attaching admits nothing.
      console.log(
        `  ${body.refresh.added.length} tool(s) found, all blocked: ${body.refresh.added.join(", ")}`,
      );
      console.log(`  Allow one by name: lacrew mcp allow ${body.server.id}.<tool>`);
    } else {
      console.log("  it published no tools.");
    }
    return;
  }

  if (sub === "detach") {
    const id = rest[0];
    if (!id) throw new Error("lacrew mcp detach <server>");
    await orchFetch(args, "/mcp/servers/detach", {
      method: "POST",
      body: JSON.stringify({ server: id }),
    });
    console.log(
      `Detached ${id}. Its tool rules are kept, so re-attaching it does not silently re-admit one.`,
    );
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
  attach <id>               Attach a server now, no restart (see flags below)
  detach <id>               Forget a server attached at runtime
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

attach flags:
  --endpoint https://…      Where the server is (http transport)
  --command <bin> --arg x   Run it as a subprocess instead (self-host only)
  --title <name>            Label for an operator surface
  --token-env NAME          Env var holding a bearer token — the NAME, never the token
  --header H --header-env N Custom auth header and the env var holding its value
  --env NAME                Env var to pass a stdio child (repeatable)
  --json '<config>'         The whole config, for shapes the flags do not cover

A tool is refused until it is allowed by name, and a tool that appears on a
server after registration starts blocked — including one added between two
refreshes. A wildcard may only narrow: <server>.* can deny, never admit.
Attaching admits nothing either: discovery runs immediately and records every
tool it finds as blocked.

A hosted orchestrator (LACREW_MCP_HOSTED=1) refuses stdio and reaches only the
hosts its operator allowlisted; "servers" prints that policy above the list.

Env:
  ORCH_URL     Orchestrator base URL (default http://127.0.0.1:8788)
  ORCH_TOKEN   Bearer token (pairs with LACREW_ORCH_TOKEN)`);
}
