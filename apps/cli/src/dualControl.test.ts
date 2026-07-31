import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cmdDualControl, coverage, scopeFrom } from "./dualControl.js";

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
    await cmdDualControl(args);
  } finally {
    console.log = log;
  }
  return out.join("\n");
}

const MANAGER = "0x2222222222222222222222222222222222222222";
const WORKER = "0x3333333333333333333333333333333333333333";

const RULE = {
  scope: { level: "workspace" as const },
  mode: "risky_writes" as const,
  reviewer: { kind: "manager" as const },
  threshold: { minSpend: "0", connectorWrites: true, orgMutators: true },
  timeoutMs: 86_400_000,
  at: "2026-07-31T12:00:00.000Z",
};

const LIST_BODY = {
  rules: [RULE],
  modes: ["off", "risky_writes", "spends_and_writes"],
  reviewers: ["manager", "seat:<address>", "role:human", "any_peer_in_crew"],
};

describe("lacrew dual-control", () => {
  beforeEach(() => {
    calls = [];
    responder = () => ({ body: LIST_BODY });
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("names a scope explicitly rather than defaulting to every crew", () => {
    assert.deepEqual(scopeFrom(["--workspace"]), { level: "workspace" });
    assert.deepEqual(scopeFrom(["--crew", MANAGER]), { level: "crew", ref: MANAGER });
    assert.throws(() => scopeFrom([]), /name a scope/);
    assert.throws(() => scopeFrom(["--crew", MANAGER, "--agent", WORKER]), /not both/);
  });

  it("says what a rule actually covers, not just its mode", () => {
    assert.equal(coverage(RULE), "connector + MCP writes, org/budget/governance");
    assert.equal(
      coverage({
        mode: "spends_and_writes",
        threshold: { minSpend: "1000000", connectorWrites: false, orgMutators: true },
      }),
      "spends ≥ 1000000, org/budget/governance",
    );
    assert.equal(coverage({ ...RULE, mode: "off" }), "nothing");
  });

  it("tells an operator with no rules how to turn it on", async () => {
    responder = () => ({ body: { ...LIST_BODY, rules: [] } });
    const out = await capture(["list"]);
    assert.match(out, /every crew acts alone/);
    assert.match(out, /dual-control set --workspace --mode risky_writes/);
  });

  it("resolves one seat, and says who would actually be asked", async () => {
    responder = () => ({
      body: {
        ...LIST_BODY,
        effective: {
          mode: "risky_writes",
          reviewer: { kind: "manager" },
          threshold: RULE.threshold,
          timeoutMs: RULE.timeoutMs,
          source: { kind: "rule", scope: { level: "workspace" } },
        },
        reviewer: { via: "human", accounts: [MANAGER], human: true, escalated: true },
      },
    });
    const out = await capture(["list", "--as", WORKER]);
    assert.equal(calls[0]?.path, `/dual-control?as=${WORKER}`);
    assert.match(out, /runs under risky_writes/);
    // The escalation is the thing worth reading twice: it means the configured
    // reviewer is not the one who would answer.
    assert.match(out, /escalated, because the configured reviewer is unavailable/);
  });

  it("sends the threshold flags and refuses a reviewer nobody defined", async () => {
    responder = () => ({ body: { rule: { ...RULE, mode: "spends_and_writes" } } });
    await capture([
      "set",
      "--workspace",
      "--mode",
      "spends_and_writes",
      "--reviewer",
      `seat:${MANAGER}`,
      "--min-spend",
      "1000000",
      "--no-org-mutators",
      "--timeout-min",
      "60",
    ]);
    assert.deepEqual(calls[0]?.body, {
      scope: { level: "workspace" },
      mode: "spends_and_writes",
      reviewer: `seat:${MANAGER}`,
      timeoutMs: 3_600_000,
      minSpend: "1000000",
      orgMutators: false,
    });

    calls = [];
    await assert.rejects(() => capture(["set", "--workspace", "--mode", "risky_writes", "--reviewer", "whoever"]), /--reviewer must be/);
    assert.equal(calls.length, 0, "nothing was sent for a reviewer the CLI cannot name");
  });

  it("says plainly that an agent reviewer is review, not trust", async () => {
    responder = () => ({ body: { rule: RULE } });
    const out = await capture(["set", "--workspace", "--mode", "risky_writes"]);
    assert.match(out, /approves no spend and signs nothing onchain/);
    assert.match(out, /review, not trust/);
  });

  it("lists what is actually holding runs", async () => {
    responder = () => ({
      body: {
        reviews: [
          {
            id: "review_abc",
            tool: "github.merge_pull_request",
            effect: "write",
            actor: WORKER,
            reviewer: "manager",
            reviewers: [MANAGER],
            human: false,
            escalated: false,
            status: "pending",
            runId: "run-1",
            createdAt: RULE.at,
            expiresAt: RULE.at,
          },
        ],
        answerVia: "POST /messages with kind=answer, replyTo=<questionId>, body=concur|reject",
      },
    });
    const out = await capture(["reviews"]);
    assert.equal(calls[0]?.path, "/dual-control/reviews?status=pending");
    assert.match(out, /github\.merge_pull_request/);
    assert.match(out, new RegExp(`${WORKER} → ${MANAGER}`));
    assert.match(out, /body=concur\|reject/);
  });

  it("clearing a scope is not the same as pinning it off", async () => {
    responder = () => ({ body: { cleared: true } });
    const out = await capture(["clear", "--crew", MANAGER]);
    assert.deepEqual(calls[0]?.body, { scope: { level: "crew", ref: MANAGER }, mode: null });
    assert.match(out, /inherits whatever a broader rule says/);
  });

  it("help explains what it is not", async () => {
    const out = await capture([]);
    assert.match(out, /Not the same as a human gate/);
    assert.match(out, /Not the same as plan-required/);
    assert.match(out, /can never answer its own review/);
  });
});
