import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cmdMcp, parseScope, parseToolRef } from "./mcp.js";

async function capture(args: string[]): Promise<{ out: string; error?: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  try {
    await cmdMcp(args);
    return { out: out.join("\n") };
  } catch (err) {
    return { out: out.join("\n"), error: err instanceof Error ? err.message : String(err) };
  } finally {
    console.log = log;
  }
}

/** The orchestrator as a stubbed `fetch`; what is checked is the CLI's half. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    calls.push({
      url: path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const route = key ? routes[key]! : { status: 404, body: { error: "not_found" } };
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const SERVERS = {
  servers: [
    {
      id: "gh",
      title: "GitHub MCP",
      transport: "http",
      endpoint: "https://mcp.example.com/rpc",
      auth: { kind: "bearer", envVars: ["GH_MCP_TOKEN"], ready: true },
      blockedCount: 1,
      tools: [
        {
          name: "search_issues",
          description: "Search issues",
          enabled: true,
          effect: "read",
          mode: "auto",
          present: true,
          source: { kind: "rule", scope: { level: "workspace" } },
        },
        {
          name: "create_issue",
          enabled: false,
          effect: "write",
          mode: "deny",
          present: true,
          source: { kind: "rule", scope: { level: "workspace" } },
        },
      ],
    },
  ],
};

describe("lacrew mcp", () => {
  it("shows each tool's state and how many are blocked", async () => {
    const stub = stubFetch({ "/mcp/servers": { body: SERVERS } });
    const { out } = await capture(["servers"]);
    stub.restore();

    assert.match(out, /GitHub MCP\s+\[gh]\s+http/);
    assert.match(out, /GH_MCP_TOKEN ✓ set/);
    assert.match(out, /● search_issues\s+read\s+allowed/);
    assert.match(out, /○ create_issue\s+write deny\s+blocked/);
    assert.match(out, /1 tool\(s\) blocked until allowed by name/);
  });

  it("says a refresh blocked what it found rather than added it", async () => {
    const stub = stubFetch({
      "/mcp/servers/refresh": {
        body: {
          results: [
            {
              server: "gh",
              ok: true,
              added: ["delete_repository"],
              removed: [],
              unchanged: ["search_issues"],
            },
          ],
        },
      },
    });
    const { out } = await capture(["refresh"]);
    stub.restore();

    assert.match(out, /gh: 2 tool\(s\)/);
    assert.match(out, /new and blocked: delete_repository/);
  });

  it("reports an unreachable server without implying the allowlist moved", async () => {
    const stub = stubFetch({
      "/mcp/servers/refresh": {
        body: {
          results: [
            {
              server: "gh",
              ok: false,
              added: [],
              removed: [],
              unchanged: [],
              error: "mcp_http_502:gh",
            },
          ],
        },
      },
    });
    const { out } = await capture(["refresh", "gh"]);
    stub.restore();

    assert.match(out, /gh: unreachable — mcp_http_502:gh\. The allowlist is unchanged\./);
  });

  it("allows one tool with its effect and mode, at the scope asked for", async () => {
    const stub = stubFetch({ "/mcp/servers/tools": { body: { rule: {} } } });
    const { out } = await capture([
      "allow",
      "gh.create_issue",
      "--effect",
      "write",
      "--mode",
      "ask",
      "--scope",
      "crew:0xdesk",
    ]);
    stub.restore();

    assert.equal(stub.calls[0]!.method, "PUT");
    assert.deepEqual(stub.calls[0]!.body, {
      scope: { level: "crew", ref: "0xdesk" },
      server: "gh",
      tool: "create_issue",
      enabled: true,
      effect: "write",
      mode: "ask",
    });
    // Said at the point of the decision: this admits a tool and nothing else.
    assert.match(out, /changes no cap, whitelist, session scope or policy/);
  });

  it("denies a whole server with a wildcard", async () => {
    const stub = stubFetch({ "/mcp/servers/tools": { body: { rule: {} } } });
    await capture(["deny", "gh.*", "--scope", "agent:0xabc"]);
    stub.restore();

    assert.deepEqual(stub.calls[0]!.body, {
      scope: { level: "agent", ref: "0xabc" },
      server: "gh",
      tool: "*",
      enabled: false,
    });
  });

  it("clears a rule so the tool inherits again", async () => {
    const stub = stubFetch({ "/mcp/servers/tools": { body: { cleared: true } } });
    const { out } = await capture(["clear", "gh.search_issues", "--scope", "agent:0xabc"]);
    stub.restore();

    assert.equal((stub.calls[0]!.body as { enabled?: boolean }).enabled, undefined);
    assert.match(out, /it inherits again/);
  });

  it("surfaces a refusal from the orchestrator rather than reporting success", async () => {
    const stub = stubFetch({
      "/mcp/servers/tools": {
        status: 400,
        body: { error: 'rule "gh.*" cannot enable: a wildcard may only narrow' },
      },
    });
    const { error } = await capture(["allow", "gh.*"]);
    stub.restore();

    assert.match(error ?? "", /wildcard may only narrow/);
  });

  it("refuses a tool reference that names no server", () => {
    assert.throws(() => parseToolRef("search_issues"), /<server>\.<tool>/);
    assert.deepEqual(parseToolRef("gh.search_issues"), { server: "gh", tool: "search_issues" });
    assert.deepEqual(parseScope(undefined), { level: "workspace" });
    assert.throws(() => parseScope("team:0xabc"), /--scope takes workspace/);
  });
});
