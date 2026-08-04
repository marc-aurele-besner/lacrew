import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cmdPnl } from "./pnl.js";

type Call = { path: string; accept: string | null };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let responder: (call: Call) => {
  status?: number;
  body?: unknown;
  text?: string;
};

/** Stands in for a running orchestrator: the CLI is what is under test. */
function installFetch(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    const call: Call = {
      path: href.replace("http://127.0.0.1:8788", ""),
      accept: (init?.headers as Record<string, string> | undefined)?.accept ?? null,
    };
    calls.push(call);
    const { status = 200, body, text } = responder(call);
    if (text !== undefined) {
      return new Response(text, {
        status,
        headers: { "content-type": "text/csv" },
      });
    }
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
    await cmdPnl(args);
  } finally {
    console.log = log;
  }
  return out.join("\n");
}

const REPORT = {
  scope: { kind: "crew", crewId: "0x2222222222222222222222222222222222222222" },
  period: {
    kind: "calendar_month",
    key: "2026-07",
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-08-01T00:00:00.000Z",
    timezone: "UTC",
  },
  asOf: "2026-07-31T12:00:00.000Z",
  totals: {
    onchain: {
      assets: [
        {
          asset: "USDC",
          spent: "50000000",
          pending: "75000000",
          granted: "200000000",
          marketplace: "0",
        },
      ],
      spends: [],
      pending: [],
      grants: [],
      marketplace: [],
      counts: { spends: 1, pending: 1, grants: 1, marketplace: 0 },
    },
    inference: {
      inputTokens: 1_000,
      outputTokens: 250,
      usdMicros: 4_500,
      calls: 2,
      unpricedCalls: 1,
      byFlow: [],
      byModel: [],
    },
    connectors: {
      calls: 3,
      reads: 2,
      writes: 1,
      failed: 1,
      routes: [],
      usdMicros: null,
      pricedCalls: 0,
      unpricedCalls: 3,
    },
  },
  seats: [
    {
      agentId: "0x3333333333333333333333333333333333333333",
      label: "Worker 1",
      onchain: {
        assets: [
          {
            asset: "USDC",
            spent: "50000000",
            pending: "0",
            granted: "0",
            marketplace: "0",
          },
        ],
        spends: [],
        pending: [],
        grants: [],
        marketplace: [],
        counts: { spends: 1, pending: 0, grants: 0, marketplace: 0 },
      },
      inference: {
        inputTokens: 1_000,
        outputTokens: 250,
        usdMicros: 4_500,
        calls: 1,
        unpricedCalls: 0,
        byFlow: [],
        byModel: [],
      },
      connectors: {
        calls: 3,
        reads: 2,
        writes: 1,
        failed: 1,
        routes: [],
        usdMicros: null,
        pricedCalls: 0,
        unpricedCalls: 3,
      },
    },
  ],
  unattributed: {
    inference: { calls: 1, usdMicros: 0, unpricedCalls: 1 },
    connectors: { calls: 0 },
  },
  headroom: { onchain: [], inference: null },
  sources: {
    onchain: { available: true, complete: false, store: "memory" },
    inference: { available: true, complete: true, store: "postgres" },
    connectors: { available: true, complete: false, store: "memory" },
  },
  notes: ["1 model call(s) had no known price — the inference $ figure is a floor."],
};

beforeEach(() => {
  calls = [];
  responder = () => ({ body: REPORT });
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("lacrew pnl", () => {
  it("asks for the window the operator named", async () => {
    await capture(["--crew", "trading", "--period", "calendar_week"]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.path.startsWith("/pnl?"));
    assert.ok(calls[0]!.path.includes("crewId=trading"));
    assert.ok(calls[0]!.path.includes("period=calendar_week"));
  });

  it("takes the crew as a bare argument too", async () => {
    await capture(["trading"]);
    assert.ok(calls[0]!.path.includes("crewId=trading"));
  });

  it("prints the three meters, and says which figures are floors", async () => {
    const out = await capture(["--crew", "0x2222222222222222222222222222222222222222"]);
    assert.match(out, /Onchain\s+50\.00 USDC spent/);
    assert.match(out, /Inference\s+\$0\.0045/);
    assert.match(out, /1 unpriced — this is a floor/);
    assert.match(out, /Connectors\s+3 call\(s\)/);
    // Connector price is unknown, not zero.
    assert.match(out, /price unknown/);
    assert.match(out, /sources: onchain memory \(partial\)/);
    assert.match(out, /Worker 1/);
  });

  it("passes the CSV format through untouched", async () => {
    responder = () => ({ text: "scope,seat,meter\n*,*,onchain_spent" });
    const out = await capture(["--crew", "trading", "--csv"]);
    assert.ok(calls[0]!.path.includes("format=csv"));
    assert.match(out, /scope,seat,meter/);
  });

  it("reports the orchestrator's refusal rather than an empty report", async () => {
    responder = () => ({ status: 400, body: { error: "period_too_long" } });
    await assert.rejects(
      () => capture(["--crew", "trading", "--from", "2020-01-01T00:00:00Z"]),
      /period_too_long/,
    );
  });

  it("says what it is not, in help", async () => {
    const out = await capture(["help"]);
    assert.match(out, /approves nothing, moves nothing/);
    assert.match(out, /bound different things/);
  });
});
