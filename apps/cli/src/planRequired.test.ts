import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cmdPlanRequired, scopeFrom } from "./planRequired.js";

/** One recorded call against the orchestrator's HTTP surface. */
type Call = { path: string; method: string; body: unknown };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let responder: (call: Call) => { status?: number; body: unknown };

/**
 * Stand in for a running orchestrator. The CLI is the unit under test: what
 * matters is the request it composes from the flags and what it prints back.
 */
function installFetch(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    const call: Call = {
      path: href.replace("http://127.0.0.1:8788", ""),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function capture(args: string[]): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  try {
    await cmdPlanRequired(args);
  } finally {
    console.log = log;
  }
  return out.join("\n");
}

const RULE = {
  scope: { level: "workspace" as const },
  mode: "side_effects" as const,
  windowMs: 1_800_000,
  minPlanChars: 24,
  acceptUpstreamPlan: false,
  at: "2026-07-31T12:00:00.000Z",
};

describe("lacrew plan-required", () => {
  beforeEach(() => {
    calls = [];
    responder = () => ({ body: { rules: [RULE], modes: ["off", "spends_only", "side_effects"] } });
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("tells an operator how to turn it on when nothing is configured", async () => {
    responder = () => ({ body: { rules: [], modes: ["off", "spends_only", "side_effects"] } });
    const out = await capture(["list"]);
    assert.match(out, /every crew acts unannounced/);
    assert.match(out, /plan-required set --workspace --mode side_effects/);
  });

  it("resolves one seat and names what decided it", async () => {
    responder = () => ({
      body: {
        rules: [RULE],
        modes: ["off", "spends_only", "side_effects"],
        effective: {
          mode: "spends_only",
          windowMs: 900_000,
          minPlanChars: 24,
          acceptUpstreamPlan: false,
          source: { kind: "rule", scope: { level: "crew", ref: "0xdesk" } },
        },
      },
    });
    const out = await capture(["list", "--as", "0xworker"]);
    assert.equal(calls[0]?.path, "/plan-required?as=0xworker");
    assert.match(out, /0xworker runs under spends_only \(from crew:0xdesk\), window 15m/);
  });

  it("sends minutes as milliseconds and says a plan approves nothing", async () => {
    responder = () => ({ body: { rule: { ...RULE, windowMs: 900_000 } } });
    const out = await capture([
      "set",
      "--workspace",
      "--mode",
      "side_effects",
      "--window-min",
      "15",
    ]);
    assert.equal(calls[0]?.method, "PUT");
    assert.deepEqual(calls[0]?.body, {
      scope: { level: "workspace" },
      mode: "side_effects",
      windowMs: 900_000,
    });
    assert.match(out, /claim, not an approval/);
  });

  it("refuses a mode nobody defined, and a scope nobody named", async () => {
    await assert.rejects(
      () => cmdPlanRequired(["set", "--workspace", "--mode", "always"]),
      /--mode must be/,
    );
    await assert.rejects(() => cmdPlanRequired(["set", "--mode", "off"]), /name a scope/);
    assert.equal(calls.length, 0, "nothing was sent for a request that could not be formed");
  });

  it("clears a rule rather than pinning it off", async () => {
    responder = () => ({ body: { cleared: true } });
    const out = await capture(["clear", "--agent", "0xworker"]);
    assert.deepEqual(calls[0]?.body, { scope: { level: "agent", ref: "0xworker" }, mode: null });
    assert.match(out, /inherits whatever a broader rule says/);
  });

  it("takes one scope flag, never two", () => {
    assert.deepEqual(scopeFrom(["--crew", "0xdesk"]), { level: "crew", ref: "0xdesk" });
    assert.throws(() => scopeFrom(["--crew", "0xdesk", "--agent", "0xworker"]), /not both/);
  });
});
