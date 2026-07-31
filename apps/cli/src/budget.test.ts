import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cmdBudget } from "./budget.js";

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
    await cmdBudget(args);
  } finally {
    console.log = log;
  }
  return out.join("\n");
}

const VIEW = {
  scopeKey: "crew:trading",
  budget: {
    crewId: "trading",
    period: "calendar_month",
    limits: { maxUsd: 200 },
    policy: "hard",
    cheapModel: "cheap/model",
    pauseHeartbeatOnBreach: true,
    enabled: true,
    updatedAt: "2026-07-30T14:00:00.000Z",
  },
  period: {
    key: "2026-07",
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-08-01T00:00:00.000Z",
  },
  status: {
    state: "warning",
    ratio: 0.86,
    worst: "usd",
    usage: {
      inputTokens: 1_200,
      outputTokens: 800,
      usdMicros: 172_000_000,
      calls: 40,
      unpricedCalls: 3,
    },
    remaining: { usd: 28 },
    usdIncomplete: true,
  },
};

describe("lacrew budget", () => {
  beforeEach(() => {
    calls = [];
    responder = () => ({ body: {} });
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("prints the standing, the limits, and what the guard actually compares", async () => {
    responder = () => ({ body: { budgets: [VIEW], store: "postgres" } });
    const out = await capture(["list"]);
    assert.match(out, /crew:trading\s+hard\s+warning/);
    assert.match(out, /2026-07/);
    assert.match(out, /\$200/);
    assert.match(out, /86% of usd/);
    assert.match(out, /fall back to cheap\/model/);
    assert.match(out, /refuse model calls and hold the heartbeat/);
  });

  it("says out loud that the dollar figure is a floor", async () => {
    responder = () => ({ body: { budgets: [VIEW], store: "memory" } });
    const out = await capture(["list"]);
    assert.match(out, /3 call\(s\) had no known price — the \$ figure is a floor/);
  });

  it("points at how to set the first budget rather than printing nothing", async () => {
    responder = () => ({ body: { budgets: [], store: "memory" } });
    const out = await capture(["list"]);
    assert.match(out, /No crew has an inference budget/);
    assert.match(out, /budget set --crew trading/);
  });

  it("composes the save from the flags, defaulting to soft", async () => {
    responder = () => ({ body: { budget: { ...VIEW.budget, policy: "soft", enabled: false } } });
    await capture([
      "set",
      "--crew",
      "trading",
      "--usd",
      "200",
      "--out-tokens",
      "500000",
      "--cheap-model",
      "cheap/model",
    ]);
    assert.equal(calls[0]!.path, "/budgets");
    const sent = (calls[0]!.body as { budget: Record<string, unknown> }).budget;
    assert.deepEqual(sent.limits, { maxUsd: 200, maxOutputTokens: 500_000 });
    assert.equal(sent.policy, "soft");
    assert.equal(sent.cheapModel, "cheap/model");
    assert.equal(sent.enabled, false);
  });

  it("carries --hard, --enable, --keep-heartbeat and a window period", async () => {
    responder = () => ({ body: { budget: { ...VIEW.budget, enabled: true } } });
    await capture([
      "set",
      "--crew",
      "trading",
      "--usd",
      "50",
      "--period",
      "window",
      "--window-days",
      "7",
      "--hard",
      "--keep-heartbeat",
      "--enable",
    ]);
    const sent = (calls[0]!.body as { budget: Record<string, unknown> }).budget;
    assert.equal(sent.policy, "hard");
    assert.equal(sent.period, "window");
    assert.equal(sent.windowDays, 7);
    assert.equal(sent.pauseHeartbeatOnBreach, false);
    assert.equal(sent.enabled, true);
  });

  it("warns that a soft budget blocks nothing", async () => {
    responder = () => ({ body: { budget: { ...VIEW.budget, policy: "soft", enabled: true } } });
    const out = await capture(["set", "--crew", "trading", "--usd", "10", "--enable"]);
    assert.match(out, /Soft: this warns and blocks nothing/);
  });

  it("refuses a non-numeric limit before it reaches the orchestrator", async () => {
    await assert.rejects(
      () => capture(["set", "--crew", "trading", "--usd", "lots"]),
      /--usd must be a number/,
    );
    assert.equal(calls.length, 0);
  });

  it("scopes a seat budget with --agent on every subcommand that takes one", async () => {
    responder = () => ({ body: { budget: VIEW } });
    await capture(["show", "--crew", "trading", "--agent", "0xabc"]);
    assert.match(calls[0]!.path, /crewId=trading&agentId=0xabc/);

    responder = () => ({ body: { removed: true } });
    await capture(["remove", "--crew", "trading", "--agent", "0xabc"]);
    assert.deepEqual(calls[1]!.body, { crewId: "trading", agentId: "0xabc" });
  });

  it("labels an unpriced call as unknown rather than as free", async () => {
    responder = () => ({
      body: {
        budget: VIEW,
        events: [
          {
            model: "local-llama",
            inputTokens: 10,
            outputTokens: 20,
            usdMicros: null,
            priceSource: "none",
            tokensEstimated: true,
            runId: "run-1",
            at: "2026-07-30T14:01:00.000Z",
          },
        ],
      },
    });
    const out = await capture(["usage", "--crew", "trading"]);
    assert.match(out, /\$ unknown/);
    assert.match(out, /local-llama/);
    assert.match(out, /\[run-1\]/);
    assert.match(out, /tokens approx\./);
  });

  it("surfaces the orchestrator's refusal verbatim", async () => {
    responder = () => ({ status: 400, body: { error: "invalid_inference_budget: maxUsd must be a positive number" } });
    await assert.rejects(
      () => capture(["set", "--crew", "trading", "--usd", "-1", "--enable"]),
      /maxUsd must be a positive number/,
    );
  });

  it("keeps the two kinds of budget apart in its own help", async () => {
    const out = await capture(["help"]);
    assert.match(out, /This is not an onchain budget/);
    assert.match(out, /is not a PolicyModule/);
  });
});
