import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ZERO_USAGE, flow, type CrewHeartbeat, type InferenceUsage } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createHeartbeatSurface, heartbeatThreadId } from "./heartbeat.js";
import { createMemoryHeartbeatStore, type HeartbeatStore } from "./heartbeatStore.js";
import { threadIdOf } from "./conversation.js";
import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./model/index.js";

const CREW = "trading";
const WORKER = "0x1111111111111111111111111111111111111111" as const;

/** A model whose answer the test decides, so a skill item's report is a fixture. */
class ScriptedModel implements ModelProvider {
  readonly name = "scripted";
  text = "NOTHING TO REPORT";
  readonly seen: ModelCompleteInput[] = [];

  async complete(input: ModelCompleteInput): Promise<ModelCompleteResult> {
    this.seen.push(input);
    return { text: this.text, model: input.model ?? "scripted/stub" };
  }
}

/**
 * A backend that is present but does nothing interesting.
 *
 * Present is the load-bearing part: `createFlowsSurface` swaps in the detached
 * mock when none is given, and the mock answers `complete` itself — a skill
 * item's report would then be the mock's echo rather than the model's.
 */
const mcpBackend: McpToolBackend = {
  getOrgTree: async () => [],
  listPendingIntents: async () => [],
  proposeIntent: async () => ({ intentId: "x", verdict: "ALLOW" }),
  resolveIntent: async () => ({ ok: true }),
};

async function makeSurface(
  over: {
    store?: HeartbeatStore;
    usageForRuns?: (runIds: string[]) => Promise<InferenceUsage>;
    /** Extra flow ids to save, for tests that need more than the default two. */
    flowIds?: string[];
  } = {},
) {
  const runtime = new CrewRuntime({
    client: createLacrewClient({ useMock: true }),
    workerAgent: WORKER,
  });
  const model = new ScriptedModel();
  const flows = createFlowsSurface({
    runtime,
    model,
    mcpBackend,
    store: createMemoryFlowStore(),
  });
  await flows.save(
    flow("desk-risk-sweep", "Risk sweep").model("look", { prompt: "{{input}}" }).build(),
  );
  await flows.save(flow("desk-digest", "Digest").model("write", { prompt: "summarize" }).build());
  for (const id of over.flowIds ?? []) {
    await flows.save(flow(id, id).model("look", { prompt: "{{input}}" }).build());
  }
  const heartbeats = createHeartbeatSurface({
    runtime,
    flows,
    store: over.store ?? createMemoryHeartbeatStore(),
    ...(over.usageForRuns ? { usageForRuns: over.usageForRuns } : {}),
  });
  return { runtime, flows, model, heartbeats };
}

const config = (over: Partial<CrewHeartbeat> = {}) => ({
  crewId: CREW,
  schedule: "*/30 * * * *",
  checklist: [{ kind: "flow" as const, id: "desk-risk-sweep" }],
  principal: WORKER,
  enabled: true,
  ...over,
});

/** A minute the default half-hourly schedule matches. */
const DUE = new Date("2026-07-30T14:30:00Z");

const thread = (runtime: CrewRuntime) => runtime.thread({ kind: "crew", id: CREW }, 50);

describe("heartbeat — what may be put on a checklist", () => {
  it("refuses a flow id this orchestrator does not have", async () => {
    const { heartbeats } = await makeSurface();
    await assert.rejects(
      heartbeats.save(config({ checklist: [{ kind: "flow", id: "nope" }] })),
      /heartbeat_unknown_flow: nope/,
    );
    assert.equal(heartbeats.list().length, 0);
  });

  it("refuses a skill the principal's directive does not carry, and accepts it once it does", async () => {
    const { runtime, heartbeats } = await makeSurface();
    const checklist = [{ kind: "skill" as const, id: "morning-review" }];
    await assert.rejects(
      heartbeats.save(config({ checklist })),
      /heartbeat_unknown_skill: morning-review/,
    );

    runtime.setAgentBrief(WORKER, [
      {
        label: "agent",
        skills: [{ name: "morning-review", instructions: "Check the overnight fills." }],
      },
    ]);
    const saved = await heartbeats.save(config({ checklist }));
    assert.equal(saved.checklist.length, 1);
  });

  it("refuses a cadence under the floor before anything is stored", async () => {
    const { heartbeats } = await makeSurface();
    await assert.rejects(heartbeats.save(config({ schedule: "* * * * *" })), /invalid_heartbeat/);
    assert.equal(heartbeats.list().length, 0);
  });
});

describe("heartbeat — when it fires", () => {
  it("does not fire while disabled, and fires once enabled", async () => {
    const { heartbeats } = await makeSurface();
    await heartbeats.save(config({ enabled: false }));
    assert.equal((await heartbeats.sweep(DUE)).length, 0);

    await heartbeats.setEnabled(CREW, true);
    assert.equal((await heartbeats.sweep(DUE)).length, 1);
  });

  it("skips quiet hours and runs normally at the next window outside them", async () => {
    const { heartbeats } = await makeSurface();
    await heartbeats.save(
      config({ schedule: "0 * * * *", quietHours: { start: "22:00", end: "07:00" } }),
    );
    assert.equal((await heartbeats.sweep(new Date("2026-07-30T23:00:00Z"))).length, 0);
    assert.equal((await heartbeats.sweep(new Date("2026-07-30T07:00:00Z"))).length, 1);
  });

  it("fires a window once, however many times the sweep is dispatched", async () => {
    const { heartbeats } = await makeSurface();
    await heartbeats.save(config());
    assert.equal((await heartbeats.sweep(DUE)).length, 1);
    assert.equal((await heartbeats.sweep(DUE)).length, 0);
    // The next window is a different claim, so the heartbeat keeps beating.
    assert.equal((await heartbeats.sweep(new Date("2026-07-30T15:00:00Z"))).length, 1);
  });

  it("runs on request off-schedule without consuming the scheduled window", async () => {
    const { heartbeats } = await makeSurface();
    await heartbeats.save(config());
    const manual = await heartbeats.runNow(CREW);
    assert.equal(manual.status, "ok");
    assert.ok(manual.windowKey.startsWith("manual:"));
    // The tick the operator was testing still happens.
    assert.equal((await heartbeats.sweep(DUE)).length, 1);
  });

  it("runs again on a second press rather than calling the first one still running", async () => {
    const { heartbeats } = await makeSurface();
    await heartbeats.save(config());
    const first = await heartbeats.runNow(CREW);
    const second = await heartbeats.runNow(CREW);
    assert.equal(second.status, "ok");
    assert.notEqual(first.windowKey, second.windowKey);
  });
});

describe("heartbeat — working the checklist", () => {
  it("runs every item in order and reports a clean tick as one short note", async () => {
    const { runtime, heartbeats } = await makeSurface();
    await heartbeats.save(
      config({
        checklist: [
          { kind: "flow", id: "desk-risk-sweep" },
          { kind: "flow", id: "desk-digest" },
        ],
      }),
    );
    const [tick] = await heartbeats.sweep(DUE);
    assert.ok(tick);
    assert.equal(tick.status, "ok");
    assert.deepEqual(
      tick.items.map((i) => i.id),
      ["desk-risk-sweep", "desk-digest"],
    );

    const posted = thread(runtime);
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.kind, "note");
    assert.match(posted[0]!.body, /HEARTBEAT_OK/);
    // Refs make the claim checkable: every run it says it did is named.
    assert.deepEqual(
      posted[0]!.refs?.map((r) => r.id).sort(),
      tick.items.map((i) => i.runId!).sort(),
    );
  });

  const twoItems = [
    { kind: "flow" as const, id: "desk-risk-sweep" },
    { kind: "flow" as const, id: "desk-digest" },
  ];

  it("keeps going after a failing item", async () => {
    const { flows, heartbeats } = await makeSurface();
    await heartbeats.save(config({ checklist: twoItems }));
    // Removed after the checklist was accepted — the shape a flow deleted out
    // from under a live heartbeat actually takes.
    await flows.remove("desk-risk-sweep");

    const [tick] = await heartbeats.sweep(DUE);
    assert.equal(tick!.status, "failed");
    assert.deepEqual(
      tick!.items.map((i) => i.status),
      ["failed", "ok"],
    );
    assert.match(tick!.items[0]!.detail!, /flow_not_found/);
  });

  it("stops at the first failure when told to", async () => {
    const { flows, heartbeats } = await makeSurface();
    await heartbeats.save(config({ checklist: twoItems, stopOnError: true }));
    await flows.remove("desk-risk-sweep");

    const [tick] = await heartbeats.sweep(DUE);
    assert.equal(tick!.items.length, 1);
    assert.equal(tick!.items[0]!.status, "failed");
  });

  it("skips a paused principal, names it, and runs nothing as that seat", async () => {
    const { runtime, flows, heartbeats } = await makeSurface();
    await heartbeats.save(config());
    await runtime.pauseAgent(WORKER, "incident");

    const [tick] = await heartbeats.sweep(DUE);
    assert.equal(tick!.status, "skipped");
    assert.equal(tick!.items[0]!.status, "skipped");
    assert.equal(tick!.items[0]!.detail, "agent_paused");
    assert.equal(tick!.items[0]!.runId, undefined);
    assert.equal(flows.runs().length, 0);
    // Reported even though nothing failed: a silent gap reads as a clean tick.
    assert.match(thread(runtime)[0]!.body, /skipped/);
  });

  it("stays silent on a clean tick when asked to, and never on a bad one", async () => {
    const { runtime, flows, heartbeats } = await makeSurface();
    await heartbeats.save(config({ notifyOnOk: false }));
    await heartbeats.sweep(DUE);
    assert.equal(thread(runtime).length, 0);

    await flows.remove("desk-risk-sweep");
    await heartbeats.sweep(new Date("2026-07-30T15:00:00Z"));
    const posted = thread(runtime);
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.kind, "result");
    assert.match(posted[0]!.body, /need you/);
  });
});

describe("heartbeat — skill items", () => {
  const withSkill = async () => {
    const made = await makeSurface();
    made.runtime.setAgentBrief(WORKER, [
      {
        label: "agent",
        skills: [
          {
            name: "morning-review",
            when: "each morning",
            instructions: "Check the overnight fills against the desk's limits.",
          },
        ],
      },
    ]);
    await made.heartbeats.save(
      config({ checklist: [{ kind: "skill", id: "morning-review" }], model: "cheap/model" }),
    );
    return made;
  };

  it("passes a quiet report through as nothing to report", async () => {
    const { runtime, heartbeats } = await withSkill();
    const [tick] = await heartbeats.sweep(DUE);
    assert.equal(tick!.status, "ok");
    assert.equal(tick!.items[0]!.detail, undefined);
    assert.match(thread(runtime)[0]!.body, /HEARTBEAT_OK/);
  });

  it("surfaces anything else as needing a human, with what it said", async () => {
    const { runtime, model, heartbeats } = await withSkill();
    model.text = "Two fills breached the overnight limit.";
    const [tick] = await heartbeats.sweep(DUE);
    assert.equal(tick!.status, "attention");
    assert.match(tick!.items[0]!.detail!, /breached the overnight limit/);
    assert.match(thread(runtime)[0]!.body, /breached the overnight limit/);
  });

  it("runs the skill as one model step with no tool access, on the cheap model", async () => {
    const { flows, model, heartbeats } = await withSkill();
    await heartbeats.sweep(DUE);
    const run = flows.runs()[0]!;
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0]!.stepId, "skill");
    assert.equal(model.seen[0]!.model, "cheap/model");
    // The body reaches the model; the surrounding instruction says it has none.
    assert.match(model.seen[0]!.prompt, /overnight fills against the desk's limits/);
    assert.match(model.seen[0]!.prompt, /no tools on this step/);
  });
});

describe("heartbeat — the trail", () => {
  it("records a tick under its own event type, apart from the runs it caused", async () => {
    const { runtime, heartbeats } = await makeSurface();
    await heartbeats.save(config());
    await heartbeats.sweep(DUE);

    const events = await runtime.audit();
    const tick = events.find((e) => e.type === "CrewHeartbeat");
    assert.ok(tick, "a tick event was recorded");
    assert.equal(tick!.payload.crewId, CREW);
    assert.equal(tick!.payload.status, "ok");
    assert.equal(tick!.payload.items, 1);

    // The flow run is its own row, and says what fired it.
    const run = events.find((e) => e.type === "FlowRun");
    assert.equal(run!.payload.trigger, "heartbeat");

    // Editing the checklist is attributable too.
    assert.ok(events.some((e) => e.type === "CrewHeartbeatChanged"));
  });

  it("keeps a ledger of ticks, newest first", async () => {
    const { heartbeats } = await makeSurface();
    await heartbeats.save(config());
    await heartbeats.sweep(DUE);
    await heartbeats.sweep(new Date("2026-07-30T15:00:00Z"));

    const ticks = await heartbeats.ticks(10, CREW);
    assert.equal(ticks.length, 2);
    assert.ok(ticks[0]!.startedAt >= ticks[1]!.startedAt);
    assert.ok(ticks.every((t) => t.status === "ok" && t.finishedAt));
  });
});

describe("heartbeat — two tenants on one orchestrator", () => {
  /**
   * A pooled orchestrator holds every workspace's heartbeats in one store, so
   * the only thing keeping two of them apart is the crew id each was saved
   * under. A control plane that scopes those ids gets isolation; one that
   * passes a bare display name gets two workspaces editing one row, which is
   * the failure this covers.
   */
  const A = "t.acme.trading";
  const B = "t.globex.trading";

  it("keeps each tenant's checklist and thread to itself", async () => {
    const { runtime, heartbeats } = await makeSurface({
      flowIds: ["t.acme.sweep", "t.globex.sweep"],
    });
    await heartbeats.save(config({ crewId: A, checklist: [{ kind: "flow", id: "t.acme.sweep" }] }));
    await heartbeats.save(
      config({ crewId: B, checklist: [{ kind: "flow", id: "t.globex.sweep" }] }),
    );

    // Editing one leaves the other exactly as its own operator left it.
    await heartbeats.save(config({ crewId: B, checklist: [{ kind: "flow", id: "desk-digest" }] }));
    assert.equal(heartbeats.get(A)!.checklist[0]!.id, "t.acme.sweep");
    assert.equal(heartbeats.get(B)!.checklist[0]!.id, "desk-digest");

    await heartbeats.sweep(DUE);

    // Each summary lands in its own crew's thread, and neither thread carries
    // the other's — the property a workspace's Thread tab depends on.
    const acme = runtime.thread({ kind: "crew", id: A }, 50);
    const globex = runtime.thread({ kind: "crew", id: B }, 50);
    assert.equal(acme.length, 1);
    assert.equal(globex.length, 1);
    assert.equal(acme[0]!.threadId, heartbeatThreadId(A));
    assert.equal(globex[0]!.threadId, heartbeatThreadId(B));

    // And disabling one does not stop the other.
    await heartbeats.setEnabled(A, false);
    assert.equal(heartbeats.get(B)!.enabled, true);
    assert.deepEqual(
      (await heartbeats.sweep(new Date("2026-07-30T15:00:00Z"))).map((t) => t.crewId),
      [B],
    );
  });

  it("removes only the tenant that asked", async () => {
    const { heartbeats } = await makeSurface();
    await heartbeats.save(config({ crewId: A }));
    await heartbeats.save(config({ crewId: B }));
    assert.equal(await heartbeats.remove(A), true);
    assert.deepEqual(
      heartbeats.list().map((h) => h.crewId),
      [B],
    );
  });

  it("addresses the thread with the id it was saved under", async () => {
    // The agreement the cloud honours: one crew namespace, not two. A control
    // plane can compute the thread key from the crew id it saved, with no
    // second mapping to drift.
    assert.equal(heartbeatThreadId(A), threadIdOf({ kind: "crew", id: A }));
    assert.equal(heartbeatThreadId("Trading"), "crew:trading");
  });
});

describe("heartbeat — what a tick cost", () => {
  const usage = (over: Partial<InferenceUsage> = {}): InferenceUsage => ({
    ...ZERO_USAGE,
    inputTokens: 1_200,
    outputTokens: 300,
    usdMicros: 21_000,
    calls: 2,
    ...over,
  });

  it("attaches the metered spend to the tick and reports it in the thread", async () => {
    const asked: string[][] = [];
    const { runtime, heartbeats } = await makeSurface({
      usageForRuns: async (runIds) => {
        asked.push(runIds);
        return usage();
      },
    });
    await heartbeats.save(config());
    const [tick] = await heartbeats.sweep(DUE);

    // Only the runs this tick actually started are folded.
    assert.deepEqual(asked, [[tick!.items[0]!.runId]]);
    assert.equal(tick!.usage!.usdMicros, 21_000);
    assert.equal(tick!.usage!.calls, 2);

    const posted = thread(runtime)[0]!;
    assert.match(posted.body, /Spend: \$0\.02 over 2 model call\(s\)/);
    assert.match(posted.body, /1200 in \/ 300 out/);

    // And it survives the ledger, so a card reading last-tick sees the figure.
    const [stored] = await heartbeats.ticks(1, CREW);
    assert.equal(stored!.usage!.usdMicros, 21_000);
  });

  it("labels a figure that omits unpriced calls rather than presenting it as a total", async () => {
    const { runtime, heartbeats } = await makeSurface({
      usageForRuns: async () => usage({ unpricedCalls: 1, calls: 3 }),
    });
    await heartbeats.save(config());
    await heartbeats.sweep(DUE);
    assert.match(thread(runtime)[0]!.body, /1 unpriced/);
  });

  it("reports no spend rather than $0.00 when nothing metered the tick", async () => {
    // The distinction the whole cost surface rests on: unmeasured is not free,
    // and a zero an operator budgets against is worse than an absent line.
    const { runtime, heartbeats } = await makeSurface();
    await heartbeats.save(config());
    const [tick] = await heartbeats.sweep(DUE);
    assert.equal(tick!.usage, undefined);
    assert.doesNotMatch(thread(runtime)[0]!.body, /Spend:/);
  });

  it("still records the tick when the meter cannot be read", async () => {
    const { heartbeats } = await makeSurface({
      usageForRuns: async () => {
        throw new Error("meter_unreachable");
      },
    });
    await heartbeats.save(config());
    const [tick] = await heartbeats.sweep(DUE);
    assert.equal(tick!.status, "ok");
    assert.equal(tick!.usage, undefined);
  });
});

describe("heartbeat — last run status", () => {
  it("answers with one tick per crew, the most recent", async () => {
    const { heartbeats } = await makeSurface();
    await heartbeats.save(config());
    await heartbeats.save(config({ crewId: "research", schedule: "0 * * * *" }));
    await heartbeats.sweep(DUE);
    const second = await heartbeats.sweep(new Date("2026-07-30T15:00:00Z"));

    const last = await heartbeats.lastTicks();
    assert.equal(Object.keys(last).length, 2);
    assert.equal(last[CREW]!.windowKey, second.find((t) => t.crewId === CREW)!.windowKey);
    // A crew that has never ticked is absent rather than reported as ok.
    await heartbeats.save(config({ crewId: "quiet", enabled: false }));
    assert.equal((await heartbeats.lastTicks()).quiet, undefined);
  });
});

describe("heartbeat — restart", () => {
  it("comes back exactly as it was left, disabled included", async () => {
    const store = createMemoryHeartbeatStore();
    const first = await makeSurface();
    const beats = createHeartbeatSurface({ runtime: first.runtime, flows: first.flows, store });
    await beats.save(config({ enabled: false }));

    // A second surface over the same store is what a restart looks like here.
    const second = await makeSurface();
    const revived = createHeartbeatSurface({
      runtime: second.runtime,
      flows: second.flows,
      store,
    });
    assert.equal(await revived.hydrate(), 1);
    assert.equal(revived.get(CREW)!.enabled, false);
    assert.equal((await revived.sweep(DUE)).length, 0);
  });
});
