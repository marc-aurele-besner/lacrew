import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Connector } from "@lacrew/orchestrator";
import { cmdConnectors } from "./connectors.js";

const MERGE_AUTHORITY = "0x00000000000000000000000000000000000000aa";
const COMMENT_AUTHORITY = "0x00000000000000000000000000000000000000bb";

/** Both github writes bound, as `config` requires before it will emit anything. */
const BIND_GITHUB_WRITES = [
  "--policy-target",
  `merge_pull_request=${MERGE_AUTHORITY}`,
  "--policy-target",
  `create_issue_comment=${COMMENT_AUTHORITY}`,
];

/** Run a command with stdout captured, so assertions read what a user reads. */
async function capture(
  args: string[],
): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const priorCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    await cmdConnectors(args);
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = process.exitCode;
  process.exitCode = priorCode;
  return { out: out.join("\n"), err: err.join("\n"), code: code as number | undefined };
}

describe("lacrew connectors", () => {
  it("lists the presets that ship, with their credential modes", async () => {
    const { out } = await capture(["list"]);
    assert.match(out, /github\s+—\s+GitHub REST API/);
    assert.match(out, /auth: github-app \| token \(default github-app\)/);
  });

  it("shows both credential modes, App first, with the env vars each needs", async () => {
    const { out } = await capture(["show", "github"]);
    assert.match(out, /github-app {2}\(default\)\s+—\s+GitHub App installation/);
    assert.match(out, /env: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID/);
    assert.match(out, /token\s+—\s+Personal access token/);
    assert.match(out, /env: GH_TOKEN/);
  });

  it("shows every route and marks the one that must be admitted", async () => {
    const { out } = await capture(["show", "github"]);
    assert.match(
      out,
      /read\s+github\.get_pull_request\s+GET \/repos\/\{owner\}\/\{repo\}\/pulls\/\{number\}/,
    );
    assert.match(out, /write\s+github\.merge_pull_request.*needs a policy target/);
    assert.match(out, /--policy-target merge_pull_request=0x…/);
  });

  it("emits config a registry can take", async () => {
    const { out, code } = await capture(["config", "github", ...BIND_GITHUB_WRITES]);
    assert.equal(code, undefined);
    const parsed = JSON.parse(out) as Connector[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.id, "github");
    const merge = parsed[0]!.routes.find((r) => r.name === "merge_pull_request")!;
    assert.equal(merge.policyTarget, MERGE_AUTHORITY);
    // Each write carries its own address — binding one does not admit the other.
    const comment = parsed[0]!.routes.find((r) => r.name === "create_issue_comment")!;
    assert.equal(comment.policyTarget, COMMENT_AUTHORITY);
    // Default mode, so an operator who does not choose gets the App.
    assert.equal(parsed[0]!.auth.kind, "github-app");
  });

  it("emits the PAT form only when it is asked for", async () => {
    const { out } = await capture(["config", "github", "--auth", "token", ...BIND_GITHUB_WRITES]);
    const parsed = JSON.parse(out) as Connector[];
    assert.deepEqual(parsed[0]!.auth, { kind: "bearer", tokenEnv: "GH_TOKEN" });
  });

  it("refuses a credential mode the preset does not support", async () => {
    const { err, code } = await capture(["config", "github", "--auth", "oauth"]);
    assert.match(err, /connector_preset_unknown_auth_mode:github\.oauth/);
    assert.equal(code, 1);
  });

  it("refuses to emit a write route nothing admits", async () => {
    const { out, err, code } = await capture(["config", "github"]);
    assert.equal(out, "");
    assert.match(
      err,
      /connector_preset_unbound_policy_target:github\.(create_issue_comment|merge_pull_request)/,
    );
    assert.equal(code, 1);
  });

  it("binding one write does not admit the other", async () => {
    const { out, err, code } = await capture([
      "config",
      "github",
      "--policy-target",
      `merge_pull_request=${MERGE_AUTHORITY}`,
    ]);
    assert.equal(out, "");
    assert.match(err, /connector_preset_unbound_policy_target:github\.create_issue_comment/);
    assert.equal(code, 1);
  });

  it("refuses an address that is not one", async () => {
    const { err, code } = await capture(["config", "github", "--policy-target", "merge_pull_request=0xzz"]);
    assert.match(err, /is not a 0x address/);
    assert.equal(code, 1);
  });

  it("emits a read-only connector when the writes are left out", async () => {
    const { out, code } = await capture([
      "config",
      "github",
      "--omit",
      "merge_pull_request",
      "--omit",
      "create_issue_comment",
    ]);
    assert.equal(code, undefined);
    const parsed = JSON.parse(out) as Connector[];
    assert.ok(parsed[0]!.routes.every((r) => r.effect === "read"));
  });

  it("names the known presets when asked for one that does not ship", async () => {
    const { err, code } = await capture(["show", "bitbucket"]);
    assert.match(err, /Unknown preset "bitbucket"\. Known: github, gitlab/);
    assert.equal(code, 1);
  });

  it("shows what a preset with no default host still needs", async () => {
    const { out, code } = await capture(["show", "ghost"]);
    assert.equal(code, undefined);
    assert.match(out, /Base URL\s+⚠ none — pass --base-url/);
    assert.match(out, /--base-url https:\/\/…/);
  });

  it("says a public registry needs no credential rather than printing a blank", async () => {
    const { out } = await capture(["show", "npm"]);
    assert.match(out, /none {2}\(default\)/);
    assert.match(out, /env: none \(public API\)/);
    const { out: json, code } = await capture(["config", "npm"]);
    assert.equal(code, undefined);
    const parsed = JSON.parse(json) as Connector[];
    assert.deepEqual(parsed[0]!.auth, { kind: "none" });
  });
});

/**
 * The live subcommands (F2.24). The orchestrator is a stubbed `fetch`: what is
 * being checked is the CLI's half of the contract — which route it calls, what
 * it refuses before calling anything, and that a confirmation is posted as an
 * ordinary conversation answer rather than through a back door.
 */
describe("lacrew connectors, write policy", () => {
  function stubFetch(routes: Record<string, unknown>) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      calls.push({
        url: path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      return new Response(JSON.stringify(key ? routes[key] : {}), {
        status: key ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = original) };
  }

  const pendingAsk = {
    id: "ask_1",
    connector: "github",
    route: "merge_pull_request",
    method: "PUT",
    path: "/repos/acme/site/pulls/7/merge",
    principal: "0x00000000000000000000000000000000000000a1",
    threadId: "agent:0x00000000000000000000000000000000000000a1",
    questionId: "msg_1",
    status: "pending",
    createdAt: "2026-01-01T12:00:00.000Z",
    expiresAt: "2026-01-02T12:00:00.000Z",
  };

  it("prints the vocabulary alongside the rules, so the two are read together", async () => {
    const stub = stubFetch({
      "/connectors/modes": {
        rules: [
          {
            scope: { level: "workspace" },
            route: "github.merge_pull_request",
            mode: "ask",
            at: "2026-01-01T00:00:00.000Z",
          },
        ],
        modes: ["auto", "ask", "deny"],
      },
    });
    try {
      const { out } = await capture(["modes"]);
      assert.match(out, /ask {3}admitted by policy, a human confirms in-thread first/);
      assert.match(out, /ask\s+github\.merge_pull_request\s+workspace/);
      assert.match(out, /A rule only narrows/);
    } finally {
      stub.restore();
    }
  });

  it("sets a scoped rule and clears it", async () => {
    const stub = stubFetch({
      "/connectors/modes": {
        rule: { scope: { level: "agent", ref: "0xabc" }, route: "github.*", mode: "deny" },
        cleared: true,
        rules: [],
      },
    });
    try {
      await capture(["mode", "github.*", "deny", "--scope", "agent:0xabc"]);
      assert.deepEqual(stub.calls.at(-1)?.body, {
        scope: { level: "agent", ref: "0xabc" },
        route: "github.*",
        mode: "deny",
      });

      const { out } = await capture(["mode", "github.*", "--clear", "--scope", "agent:0xabc"]);
      assert.equal((stub.calls.at(-1)?.body as { mode: unknown }).mode, null);
      assert.match(out, /now runs at whatever it inherits/);
    } finally {
      stub.restore();
    }
  });

  it("refuses a scope it cannot address", async () => {
    const { err, code } = await capture(["mode", "github.*", "ask", "--scope", "crew"]);
    assert.equal(code, 1);
    assert.match(err, /--scope expects workspace, crew:<address>, or agent:<address>/);
  });

  it("lists pending asks with the request a yes would release", async () => {
    const stub = stubFetch({ "/connectors/asks": { asks: [pendingAsk] } });
    try {
      const { out } = await capture(["asks"]);
      assert.match(out, /ask_1 {2}github\.merge_pull_request {2}pending/);
      assert.match(out, /PUT \/repos\/acme\/site\/pulls\/7\/merge/);
      assert.equal(stub.calls[0]?.url, "/connectors/asks?status=pending");
    } finally {
      stub.restore();
    }
  });

  it("answers by posting a conversation message, never through a back door", async () => {
    const stub = stubFetch({
      "/connectors/asks": { asks: [pendingAsk] },
      "/messages": { message: { id: "msg_2" } },
    });
    try {
      const { out } = await capture(["answer", "ask_1", "yes", "--as", "human:ops"]);
      const post = stub.calls.find((c) => c.method === "POST");
      assert.equal(post?.url, "/messages");
      assert.deepEqual(post?.body, {
        thread: pendingAsk.threadId,
        author: "human:ops",
        authorKind: "human",
        kind: "answer",
        replyTo: "msg_1",
        body: "yes",
      });
      assert.match(out, /approved no spend and changed no policy/);
    } finally {
      stub.restore();
    }
  });

  it("refuses anything but yes or no before it calls the orchestrator", async () => {
    const stub = stubFetch({});
    try {
      const { err, code } = await capture(["answer", "ask_1", "sure", "--as", "human:ops"]);
      assert.equal(code, 1);
      assert.match(err, /Free text is stored as a claim and releases nothing/);
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });

  it("refuses to answer without naming the human seat doing it", async () => {
    const { err, code } = await capture(["answer", "ask_1", "yes"]);
    assert.equal(code, 1);
    assert.match(err, /--as <human identifier>/);
  });
});
