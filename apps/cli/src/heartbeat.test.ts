import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cmdHeartbeat } from "./heartbeat.js";

/** One recorded call against the orchestrator's HTTP surface. */
type Call = { path: string; method: string; body: unknown };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let responder: (call: Call) => { status?: number; body: unknown };

/**
 * Stand in for a running orchestrator. The CLI is the unit under test: what
 * matters is the request it composes from the flags and what it prints back,
 * not that a real server is listening.
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
    await cmdHeartbeat(args);
  } finally {
    console.log = log;
  }
  return out.join("\n");
}

const HEARTBEAT = {
  crewId: "trading",
  schedule: "*/30 * * * *",
  timezone: "Europe/Paris",
  quietHours: { start: "22:00", end: "07:00" },
  checklist: [
    { kind: "flow", id: "desk-digest" },
    { kind: "skill", id: "morning-review" },
  ],
  principal: "0x1111111111111111111111111111111111111111",
  notifyOnOk: true,
  stopOnError: false,
  enabled: true,
  updatedAt: "2026-07-30T14:00:00.000Z",
};

describe("lacrew heartbeat", () => {
  beforeEach(() => {
    calls = [];
    responder = () => ({ body: {} });
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("lists cadence presets without touching an orchestrator", async () => {
    const out = await capture(["presets"]);
    assert.match(out, /Every 30 minutes/);
    assert.equal(calls.length, 0);
  });

  it("prints a heartbeat with its cadence, zone, quiet window and checklist", async () => {
    responder = () => ({
      body: { heartbeats: [HEARTBEAT], minIntervalMinutes: 10, store: "postgres" },
    });
    const out = await capture(["list"]);
    assert.match(out, /trading\s+on/);
    assert.match(out, /Europe\/Paris/);
    assert.match(out, /22:00 → 07:00/);
    assert.match(out, /flow desk-digest/);
    assert.match(out, /skill morning-review/);
    assert.match(out, /cadence floor 10 minutes/);
  });

  it("says how to make one when a deployment has none", async () => {
    responder = () => ({ body: { heartbeats: [], minIntervalMinutes: 10, store: "memory" } });
    const out = await capture(["list"]);
    assert.match(out, /No crew has a heartbeat/);
    assert.match(out, /heartbeat set --crew/);
  });

  it("composes a checklist in the order the flags name it", async () => {
    responder = () => ({ body: { heartbeat: { ...HEARTBEAT, enabled: false } } });
    await capture([
      "set",
      "--crew",
      "trading",
      "--schedule",
      "*/30 * * * *",
      "--flow",
      "desk-digest,desk-risk",
      "--skill",
      "morning-review",
      "--quiet-start",
      "22:00",
      "--quiet-end",
      "07:00",
      "--model",
      "cheap/model",
    ]);
    const sent = calls[0]!.body as { heartbeat: Record<string, unknown> };
    assert.equal(calls[0]!.path, "/heartbeats");
    assert.deepEqual(sent.heartbeat.checklist, [
      { kind: "flow", id: "desk-digest" },
      { kind: "flow", id: "desk-risk" },
      { kind: "skill", id: "morning-review" },
    ]);
    assert.deepEqual(sent.heartbeat.quietHours, { start: "22:00", end: "07:00" });
    assert.equal(sent.heartbeat.model, "cheap/model");
    // Off unless the operator said otherwise, matching the stored default.
    assert.equal(sent.heartbeat.enabled, false);
  });

  it("says a stored heartbeat is still off, and how to turn it on", async () => {
    responder = () => ({ body: { heartbeat: { ...HEARTBEAT, enabled: false } } });
    const out = await capture([
      "set",
      "--crew",
      "trading",
      "--schedule",
      "0 * * * *",
      "--flow",
      "d",
    ]);
    assert.match(out, /Stored but off/);
    assert.match(out, /heartbeat on --crew trading/);
  });

  it("reports the orchestrator's refusal rather than pretending it saved", async () => {
    responder = () => ({ status: 400, body: { error: "heartbeat_unknown_flow: ghost" } });
    await assert.rejects(
      capture(["set", "--crew", "trading", "--schedule", "0 * * * *", "--flow", "ghost"]),
      /heartbeat_unknown_flow: ghost/,
    );
  });

  it("refuses to guess a cadence", async () => {
    await assert.rejects(capture(["set", "--crew", "trading", "--flow", "d"]), /--schedule/);
    assert.equal(calls.length, 0);
  });

  it("runs the checklist now and prints what each item did", async () => {
    responder = () => ({
      body: {
        tick: {
          crewId: "trading",
          windowKey: "manual:trading@2026-07-30T14:30Z",
          status: "attention",
          messageId: "msg_1",
          startedAt: "2026-07-30T14:30:00.000Z",
          items: [
            { kind: "flow", id: "desk-digest", principal: "0x11", status: "ok", runId: "run-1" },
            {
              kind: "skill",
              id: "morning-review",
              principal: "0x11",
              status: "attention",
              runId: "run-2",
              detail: "Two fills breached the limit.",
            },
          ],
        },
      },
    });
    const out = await capture(["run", "--crew", "trading"]);
    assert.equal(calls[0]!.path, "/heartbeats/run");
    assert.match(out, /ok\s+flow desk-digest\s+\[run-1\]/);
    assert.match(out, /attention\s+skill morning-review.*breached the limit/);
    assert.match(out, /Posted to the crew thread as msg_1/);
  });

  it("turns a heartbeat on and off through the same route", async () => {
    responder = () => ({ body: { heartbeat: HEARTBEAT } });
    await capture(["off", "--crew", "trading"]);
    assert.deepEqual(calls[0]!.body, { crewId: "trading", enabled: false });
    calls = [];
    await capture(["on", "--crew", "trading"]);
    assert.deepEqual(calls[0]!.body, { crewId: "trading", enabled: true });
  });

  it("scopes the tick ledger to a crew when asked", async () => {
    responder = () => ({ body: { ticks: [] } });
    await capture(["ticks", "--crew", "trading", "--limit", "5"]);
    assert.equal(calls[0]!.path, "/heartbeats/ticks?limit=5&crewId=trading");
  });

  it("says what a heartbeat may and may not do in its own help", async () => {
    const out = await capture([]);
    assert.match(out, /only ever runs what its checklist already names/);
    assert.match(out, /session scope, whitelist or cap/);
  });
});
