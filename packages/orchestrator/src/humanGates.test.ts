/**
 * Blocking human gates end to end (F2.27): a flow reaches a `human` step, the
 * run stops, a person answers in the thread, and the run continues down the
 * port that answer names.
 *
 * Driven through the real flows surface and the real connector registry with
 * only the network stubbed, for the reason the ask-mode test is: the acceptance
 * criterion is behavioural ("the write does not run until option `yes`"), and a
 * test that mocked the gate would assert the design instead of the behaviour.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flow } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { scopeOfThread, type Message } from "./conversation.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import {
  createHumanGates,
  humanGateTtlMs,
  readGateAnswer,
  type HumanGateRecord,
} from "./humanGates.js";
import { createConnectorRegistry, type Connector } from "./connectors.js";
import { createOrchestratorApp } from "./httpApp.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { CrewRuntime } from "./runtime.js";
import type { ProtocolEvent } from "@lacrew/core";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";

const typefully: Connector = {
  id: "typefully",
  baseUrl: "https://api.typefully.com",
  auth: { kind: "bearer", tokenEnv: "TF_TOKEN" },
  routes: [
    {
      name: "create_draft",
      method: "POST",
      path: "/v1/drafts/",
      effect: "write",
      params: ["content"],
      mode: "auto",
    },
  ],
};

function harness(opts: { ttlMs?: number; now?: () => Date; assignee?: string } = {}) {
  const runtime = new CrewRuntime({
    client: createLacrewClient({ useMock: true }),
  });
  const events: ProtocolEvent[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ id: "draft-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const gates = createHumanGates({
    postQuestion: ({ threadId, author, body, options }) =>
      runtime.postMessage({
        scope: scopeOfThread(threadId) ?? { kind: "org" },
        author,
        authorKind: "agent",
        kind: "question",
        body,
        options,
      }),
    onEvent: (event) => {
      events.push(event);
      runtime.recordAudit(event);
    },
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  runtime.onMessage((message) => gates.observe(message));

  const connectors = createConnectorRegistry({
    connectors: [typefully],
    env: { TF_TOKEN: "tf_secret" },
    fetchImpl,
    checkPolicy: async () => "ALLOW",
    resolveMode: () => ({ mode: "auto", source: { kind: "route-default" } }),
  });

  const surface = createFlowsSurface({
    runtime,
    model: new MemoryModelProvider(),
    // Any backend flips the surface off its detached mock and onto the live
    // dispatch path, which is where the gate surface is reached.
    mcpBackend: {} as McpToolBackend,
    store: createMemoryFlowStore(),
    connectors,
    gates,
  });

  const def = flow("shortlist", "Publish the shortlist")
    .model("draft", { prompt: "Draft a shortlist", next: "signoff" })
    .human("signoff", {
      prompt: "Publish this shortlist?",
      options: [
        { id: "yes", label: "Publish", port: "publish" },
        { id: "no", label: "Skip", port: "memo" },
      ],
      ...(opts.assignee ? { assignee: opts.assignee } : {}),
      timeoutPort: "memo",
    })
    .tool("publish", "typefully.create_draft", { content: "{{steps.draft.text}}" }, { next: null })
    .model("memo", { prompt: "Nothing was published.", next: null })
    .build();

  return { runtime, surface, gates, calls, events, def };
}

/** The question the run is parked on. */
function openGate(h: ReturnType<typeof harness>) {
  const gate = h.gates.list().find((g) => g.status === "pending");
  assert.ok(gate, "expected an open gate");
  return gate;
}

function answer(
  h: ReturnType<typeof harness>,
  gate: { threadId: string; questionId: string },
  body: string,
  authorKind: "human" | "agent" = "human",
  who: { author?: string; authorId?: string } = {},
) {
  h.runtime.postMessage({
    scope: scopeOfThread(gate.threadId)!,
    author: who.author ?? (authorKind === "human" ? "human:ops" : "0xWORKER"),
    ...(who.authorId ? { authorId: who.authorId } : {}),
    authorKind,
    kind: "answer",
    body,
    replyTo: gate.questionId,
  });
}

describe("blocking human gates, end to end", () => {
  it("stops before the write, and takes the yes port once a human answers", async () => {
    const h = harness();
    await h.surface.save(h.def);

    const parked = await h.surface.run({ id: "shortlist" });
    assert.equal(parked.status, "waiting");
    assert.equal(parked.waiting?.reason, "human_gate");
    assert.equal(parked.waiting?.stepId, "signoff");
    assert.equal(h.calls.length, 0, "nothing was published before anyone answered");

    const gate = openGate(h);
    assert.equal(gate.runId, parked.runId);
    assert.ok(gate.resume, "the parked run is attached to the gate holding it");
    assert.deepEqual(
      h.runtime.allOpenQuestions().map((q) => q.id),
      [gate.questionId],
      "the gate shows up as an open question",
    );

    answer(h, gate, "yes");
    await h.gates.drain();

    assert.equal(h.calls.length, 1, "exactly one draft went out");
    const finished = h.surface.runs().find((r) => r.runId === parked.runId);
    assert.equal(finished?.status, "completed");
    assert.equal(finished?.steps.at(-1)?.stepId, "publish");
    assert.equal(
      h.surface.runs().filter((r) => r.runId === parked.runId).length,
      1,
      "the resumed run replaces its own waiting entry rather than appearing twice",
    );
    assert.equal(h.gates.list()[0]!.status, "consumed", "the answer is spent once");
    assert.equal(h.gates.list()[0]!.answeredBy, "human:ops");
    assert.equal(h.runtime.allOpenQuestions().length, 0, "the question closed");
  });

  it("takes the no port and never runs the write", async () => {
    const h = harness();
    await h.surface.save(h.def);
    const parked = await h.surface.run({ id: "shortlist" });

    answer(h, openGate(h), "no");
    await h.gates.drain();

    assert.equal(h.calls.length, 0);
    const finished = h.surface.runs().find((r) => r.runId === parked.runId);
    assert.equal(finished?.status, "completed");
    assert.equal(finished?.steps.at(-1)?.stepId, "memo");
  });

  it("an agent cannot satisfy the gate its own crew is parked on", async () => {
    const h = harness();
    await h.surface.save(h.def);
    await h.surface.run({ id: "shortlist" });
    const gate = openGate(h);

    answer(h, gate, "yes", "agent");
    await h.gates.drain();

    assert.equal(h.calls.length, 0, "an agent's yes releases nothing");
    assert.equal(h.gates.list()[0]!.status, "pending");
    assert.equal(
      h.events.filter((e) => e.type === "HumanGateUnresolved").length,
      1,
      "the attempt is on the trail rather than swallowed",
    );
  });

  it("an assigned gate ignores another human's answer and stays open", async () => {
    const h = harness({ assignee: "seat_42" });
    await h.surface.save(h.def);
    await h.surface.run({ id: "shortlist" });
    const gate = openGate(h);
    assert.equal(gate.assignee, "seat_42");
    const asked = gate.questionId;

    answer(h, gate, "yes", "human", { author: "Grace Hopper", authorId: "seat_7" });
    await h.gates.drain();

    assert.equal(h.calls.length, 0, "somebody else's yes publishes nothing");
    const still = h.gates.list()[0]!;
    assert.equal(still.status, "pending");
    assert.equal(
      still.questionId,
      asked,
      "the question is not re-posted: it is still open, and still theirs to answer",
    );
    const refused = h.events.find(
      (e) =>
        e.type === "HumanGateUnresolved" &&
        (e.payload as { reason?: string }).reason === "assignee_mismatch",
    );
    assert.ok(refused, "the attempt is on the trail rather than swallowed");
    assert.equal((refused!.payload as { answeredById?: string }).answeredById, "seat_7");
  });

  it("the assignee's own answer resumes the run", async () => {
    const h = harness({ assignee: "seat_42" });
    await h.surface.save(h.def);
    const parked = await h.surface.run({ id: "shortlist" });
    const gate = openGate(h);

    // Matched on the seat id the surface authenticated, not the rendered name:
    // a rename must not move who may release a run.
    answer(h, gate, "yes", "human", { author: "Ada Lovelace", authorId: "seat_42" });
    await h.gates.drain();

    assert.equal(h.calls.length, 1, "the assignee's yes is what publishes");
    const finished = h.surface.runs().find((r) => r.runId === parked.runId);
    assert.equal(finished?.status, "completed");
    assert.equal(h.gates.list()[0]!.answeredBy, "Ada Lovelace");
  });

  it("with no assignee, any human seat may still answer", async () => {
    const h = harness();
    await h.surface.save(h.def);
    const parked = await h.surface.run({ id: "shortlist" });

    answer(h, openGate(h), "yes", "human", { author: "Whoever Is Around" });
    await h.gates.drain();

    assert.equal(h.calls.length, 1, "an empty assignee is anyone, not nobody");
    assert.equal(h.surface.runs().find((r) => r.runId === parked.runId)?.status, "completed");
  });

  it("names the gate a non-assignee's answer would be refused by, before it is posted", async () => {
    const h = harness({ assignee: "seat_42" });
    await h.surface.save(h.def);
    await h.surface.run({ id: "shortlist" });
    const gate = openGate(h);

    const refusal = h.gates.assigneeRefusal({
      replyTo: gate.questionId,
      author: "Grace Hopper",
      authorId: "seat_7",
      authorKind: "human",
    });
    assert.deepEqual(refusal, {
      gateId: gate.id,
      stepId: "signoff",
      assignee: "seat_42",
    });

    assert.equal(
      h.gates.assigneeRefusal({
        replyTo: gate.questionId,
        author: "Ada",
        authorId: "seat_42",
        authorKind: "human",
      }),
      null,
      "the assignee is not refused",
    );
    assert.equal(
      h.gates.assigneeRefusal({
        replyTo: gate.questionId,
        author: "0xWORKER",
        authorKind: "agent",
      }),
      null,
      "an agent's message is ordinary traffic here; it simply resolves nothing",
    );
  });

  it("free text decides nothing and re-asks so the queue stays honest", async () => {
    const h = harness();
    await h.surface.save(h.def);
    await h.surface.run({ id: "shortlist" });
    const gate = openGate(h);
    const asked = gate.questionId;

    answer(h, gate, "sure, go ahead");
    await h.gates.drain();

    assert.equal(h.calls.length, 0);
    const still = h.gates.list()[0]!;
    assert.equal(still.status, "pending");
    assert.notEqual(still.questionId, asked, "the question was re-posted");
    assert.equal(h.runtime.allOpenQuestions().length, 1);
  });

  it("times out onto the declared port without publishing", async () => {
    let clock = new Date("2026-01-01T12:00:00.000Z");
    const h = harness({ ttlMs: 10 * 60_000, now: () => clock });
    await h.surface.save(h.def);
    const parked = await h.surface.run({ id: "shortlist" });

    clock = new Date("2026-01-01T12:20:00.000Z");
    const timedOut = await h.gates.sweep();
    await h.gates.drain();

    assert.equal(timedOut.length, 1);
    assert.equal(h.calls.length, 0, "a deadline is not a yes");
    const finished = h.surface.runs().find((r) => r.runId === parked.runId);
    assert.equal(finished?.status, "completed");
    assert.equal(finished?.steps.at(-1)?.stepId, "memo");
    assert.equal(h.events.filter((e) => e.type === "HumanGateTimedOut").length, 1);
  });

  it("a gate with no timeout port stops the run instead of continuing", async () => {
    const h = harness({
      ttlMs: 10 * 60_000,
      now: () => new Date("2026-01-01T12:00:00.000Z"),
    });
    const strict = flow("strict", "Strict")
      .human("signoff", {
        prompt: "Ship?",
        options: [{ id: "yes", port: "publish" }],
      })
      .tool("publish", "typefully.create_draft", { content: "x" }, { next: null })
      .build();
    await h.surface.save(strict);
    const parked = await h.surface.run({ id: "strict" });

    // The sweep reads the same clock the gate was opened on, so expire by hand.
    await h.gates.sweep(new Date("2026-01-01T13:00:00.000Z"));
    await h.gates.drain();

    assert.equal(h.calls.length, 0);
    const finished = h.surface.runs().find((r) => r.runId === parked.runId);
    assert.equal(finished?.status, "error");
    assert.match(String(finished?.steps.at(-1)?.error), /human_gate_timeout:signoff/);
  });

  it("cancelling the run closes the gate, and a late answer resumes nothing", async () => {
    const h = harness();
    await h.surface.save(h.def);
    const parked = await h.surface.run({ id: "shortlist" });
    const gate = openGate(h);

    await h.surface.cancel(parked.runId, "changed our minds");
    assert.equal(h.gates.get(gate.id)?.status, "cancelled");

    answer(h, gate, "yes");
    await h.gates.drain();

    assert.equal(h.calls.length, 0, "a cancelled run cannot be restarted by an answer");
    const finished = h.surface.runs().find((r) => r.runId === parked.runId);
    assert.equal(finished?.status, "cancelled");
  });

  it("re-entering the step finds the gate it already opened, not a second one", async () => {
    const h = harness();
    await h.surface.save(h.def);
    const parked = await h.surface.run({ id: "shortlist" });
    assert.equal(h.gates.list().length, 1);

    // What a boot-time recovery does: re-run the parked run from its state.
    const again = await h.surface.resume(parked.runId);
    assert.equal(again.status, "waiting");
    assert.equal(h.gates.list().length, 1, "one question, however many times it is entered");
    assert.equal(h.runtime.allOpenQuestions().length, 1);
  });

  it("a flow with no gate surface fails rather than passing the gate", async () => {
    const h = harness();
    const surface = createFlowsSurface({
      runtime: h.runtime,
      model: new MemoryModelProvider(),
      mcpBackend: {} as McpToolBackend,
      store: createMemoryFlowStore(),
    });
    await surface.save(h.def);
    const run = await surface.run({ id: "shortlist" });
    assert.equal(run.status, "error");
    assert.match(String(run.steps.at(-1)?.error), /human_gate_unavailable/);
  });

  it("survives a restart: the gate hydrates, and one answer resumes once", async () => {
    // What a redeploy looks like from the gate's side: the process that opened
    // the question is gone, and the record is all the next one has.
    const rows = new Map<string, HumanGateRecord>();
    const store = {
      loadHumanGates: async () => [...rows.values()],
      saveHumanGate: async (record: HumanGateRecord) => {
        // Snapshot, not the live object: the real store round-trips through
        // Postgres, and sharing the object would hide a lost field.
        rows.set(record.id, structuredClone(record));
      },
    };
    const posted: Message[] = [];
    const build = () =>
      createHumanGates({
        store,
        postQuestion: ({ threadId, author, body, options }) => {
          const message: Message = {
            id: `msg_${posted.length + 1}`,
            threadId,
            at: "2026-01-01T12:00:00.000Z",
            author,
            authorKind: "agent",
            kind: "question",
            body,
            options,
          };
          posted.push(message);
          return message;
        },
      });

    const request = {
      stepId: "signoff",
      prompt: "Publish?",
      options: [{ id: "yes", label: "Publish" }],
      principal: "0xWORKER",
      flowId: "shortlist",
      runId: "run-1",
    };

    const before = build();
    await assert.rejects(() => before.gate(request), /flow_waiting:human_gate/);
    const opened = before.list()[0]!;
    await before.attachResume(opened.id, { stepId: "signoff", outputs: {}, steps: [] });

    // The restart.
    const after = build();
    const resumed: string[] = [];
    after.setResumer(async (gate) => {
      resumed.push(gate.id);
    });
    assert.equal(await after.hydrate(), 1, "the open question came back");

    after.observe({
      id: "msg_answer",
      threadId: opened.threadId,
      at: "2026-01-01T12:30:00.000Z",
      author: "human:ops",
      authorKind: "human",
      kind: "answer",
      body: "yes",
      replyTo: opened.questionId,
    });
    await after.drain();
    assert.deepEqual(resumed, [opened.id], "the answer resumed the run exactly once");

    const resolution = await after.gate(request);
    assert.deepEqual(resolution.outcome, "answered");
    assert.equal(resolution.optionId, "yes");
    assert.equal(resolution.answeredBy, "human:ops");
    // And the same yes cannot release the step a second time.
    await assert.rejects(() => after.gate(request), /human_gate_spent:signoff/);
    assert.equal(posted.length, 1, "one question, across both processes");
  });

  it("answers match an offered option exactly, by id or by label", () => {
    const options = [
      { id: "yes", label: "Publish" },
      { id: "no", label: "Skip" },
    ];
    assert.equal(readGateAnswer(" YES. ", options), "yes");
    assert.equal(readGateAnswer("publish", options), "yes");
    assert.equal(readGateAnswer("Skip", options), "no");
    assert.equal(readGateAnswer("approve 500 USDC", options), null);
    assert.equal(readGateAnswer("", options), null);
  });

  it("the gate TTL is read from the environment, with a floor", () => {
    assert.equal(humanGateTtlMs({}), 24 * 60 * 60 * 1000);
    assert.equal(humanGateTtlMs({ LACREW_HUMAN_GATE_TTL_MS: "3600000" }), 3_600_000);
    assert.equal(
      humanGateTtlMs({ LACREW_HUMAN_GATE_TTL_MS: "5" }),
      24 * 60 * 60 * 1000,
      "a deadline that fires on people rather than on neglect is refused",
    );
  });
});

describe("POST /messages and an assigned gate", () => {
  /** The app a control plane (or a chat bridge) actually posts through. */
  function app(assignee?: string) {
    const h = harness(assignee ? { assignee } : {});
    return {
      h,
      http: createOrchestratorApp({
        runtime: h.runtime,
        queue: new InMemoryQueue(),
        model: new MemoryModelProvider(),
        flows: h.surface,
        humanGates: h.gates,
        mcpUseMock: true,
        isDbReady: () => false,
        isDbConfigured: () => false,
      }),
    };
  }

  const post = (http: ReturnType<typeof app>["http"], body: Record<string, unknown>) =>
    http.request("/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("refuses a non-assignee with 403 rather than storing an answer that decides nothing", async () => {
    const { h, http } = app("seat_42");
    await h.surface.save(h.def);
    await h.surface.run({ id: "shortlist" });
    const gate = openGate(h);

    const res = await post(http, {
      thread: gate.threadId,
      author: "Grace Hopper",
      authorId: "seat_7",
      authorKind: "human",
      kind: "answer",
      replyTo: gate.questionId,
      body: "yes",
    });

    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, "gate_assignee_mismatch");
    assert.equal(body.assignee, "seat_42");
    assert.equal(body.stepId, "signoff");
    assert.equal(h.calls.length, 0);
    assert.equal(h.gates.list()[0]!.status, "pending");
    assert.equal(
      h.runtime.thread(scopeOfThread(gate.threadId)!, 50).filter((m) => m.kind === "answer").length,
      0,
      "the refused answer never reached the thread",
    );
  });

  it("takes the assignee's answer, and lets anyone else still say something that is not an answer", async () => {
    const { h, http } = app("seat_42");
    await h.surface.save(h.def);
    await h.surface.run({ id: "shortlist" });
    const gate = openGate(h);

    const aside = await post(http, {
      thread: gate.threadId,
      author: "Grace Hopper",
      authorId: "seat_7",
      authorKind: "human",
      kind: "note",
      replyTo: gate.questionId,
      body: "I'd lean yes, but it's Ada's call.",
    });
    assert.equal(aside.status, 200, "a note is not an answer and is not refused");
    assert.equal(h.gates.list()[0]!.status, "pending");

    const res = await post(http, {
      thread: gate.threadId,
      author: "Ada Lovelace",
      authorId: "seat_42",
      authorKind: "human",
      kind: "answer",
      replyTo: gate.questionId,
      body: "yes",
    });
    assert.equal(res.status, 200);
    await h.gates.drain();
    assert.equal(h.calls.length, 1);
  });

  it("an unassigned gate takes any human seat's answer through the route", async () => {
    const { h, http } = app();
    await h.surface.save(h.def);
    await h.surface.run({ id: "shortlist" });
    const gate = openGate(h);

    const res = await post(http, {
      thread: gate.threadId,
      author: "Whoever Is Around",
      authorKind: "human",
      kind: "answer",
      replyTo: gate.questionId,
      body: "yes",
    });
    assert.equal(res.status, 200);
    await h.gates.drain();
    assert.equal(h.calls.length, 1);
  });
});
