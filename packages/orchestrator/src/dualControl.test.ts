/**
 * The dual-control surface itself (F2.32): what survives a restart, what a
 * concurrence is spent on, and what the environment may configure.
 *
 * The flow-level behaviour is covered in `dualControlFlow.test.ts`; what is
 * asserted here is the durability that makes the control usable in a process
 * that redeploys mid-review.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFlowWaiting, type FlowResumeState } from "@lacrew/flows";
import {
  createDualControl,
  dualControlFromEnv,
  isDualControlRefused,
  type DualControlStore,
} from "./dualControl.js";
import { createMemoryRuntimeStore } from "./runtimeStore.js";
import type { Message } from "./conversation.js";

const HUMAN = "0x1111111111111111111111111111111111111111";
const MANAGER = "0x2222222222222222222222222222222222222222";
const WORKER = "0x3333333333333333333333333333333333333333";

const CHART = [
  { account: HUMAN, kind: "human_root" as const, parent: null, active: true },
  { account: MANAGER, kind: "manager_agent" as const, parent: HUMAN, active: true },
  { account: WORKER, kind: "worker_agent" as const, parent: MANAGER, active: true },
];

/** A conversation just big enough to carry questions and answers. */
function thread() {
  const messages: Message[] = [];
  let n = 0;
  const post = (input: Omit<Message, "id" | "at">): Message => {
    const message: Message = { ...input, id: `msg_${(n += 1)}`, at: new Date().toISOString() };
    messages.push(message);
    return message;
  };
  return { messages, post };
}

function surfaceOn(store: DualControlStore, chat = thread()) {
  return createDualControl({
    store,
    postQuestion: ({ threadId, author, body, options }) =>
      chat.post({ threadId, author, authorKind: "agent", kind: "question", body, options }),
    orgSeats: () => CHART,
  });
}

const MERGE = {
  tool: "github.merge_pull_request",
  args: { owner: "acme", repo: "site", number: "7" },
  principal: WORKER,
  managers: [MANAGER],
  runId: "run-1",
  flowId: "pr-merge",
};

const RESUME = { startedAt: new Date().toISOString(), steps: [] } as unknown as FlowResumeState;

describe("dual-control durability", () => {
  it("a review opened before a restart is answered once after it", async () => {
    const store = createMemoryRuntimeStore();
    const chat = thread();

    const before = surfaceOn(store, chat);
    await before.set({ scope: { level: "workspace" }, mode: "risky_writes" });
    const parked = await before.check(MERGE).then(
      () => null,
      (err: unknown) => err,
    );
    assert.ok(isFlowWaiting(parked), "the effect parked on a review");
    await before.attachResume((parked as { token: string }).token, RESUME);

    // A different process, with nothing in memory but the same store.
    const after = surfaceOn(store, chat);
    const loaded = await after.hydrate();
    assert.equal(loaded.rules, 1);
    assert.equal(loaded.reviews, 1);

    let resumed = 0;
    after.setResumer(async () => {
      resumed += 1;
    });
    const question = chat.messages.find((m) => m.kind === "question")!;
    const answer = (author: string): void => {
      after.observe(
        chat.post({
          threadId: question.threadId,
          author,
          authorKind: "agent",
          kind: "answer",
          replyTo: question.id,
          body: "concur",
        }),
      );
    };
    answer(MANAGER);
    await after.drain();
    assert.equal(resumed, 1);

    // A second answer to a review that is no longer pending resumes nothing —
    // one concurrence releases one effect.
    answer(MANAGER);
    await after.drain();
    assert.equal(resumed, 1);

    // And the resumed run's re-entry consumes the decision, then refuses to
    // spend it twice.
    const released = await after.check(MERGE);
    assert.equal(released.required, true);
    await assert.rejects(() => after.check(MERGE), /dual_control_spent/);
  });

  it("keeps the reviewer setting across a restart, not just the mode", async () => {
    const store = createMemoryRuntimeStore();
    const before = surfaceOn(store);
    await before.set({
      scope: { level: "crew", ref: MANAGER },
      mode: "spends_and_writes",
      reviewer: { kind: "seat", account: HUMAN },
      threshold: { minSpend: "250000", connectorWrites: false },
      timeoutMs: 30 * 60_000,
    });

    const after = surfaceOn(store);
    await after.hydrate();
    const resolved = after.resolve({ principal: WORKER, managers: [MANAGER] });
    assert.equal(resolved.mode, "spends_and_writes");
    assert.deepEqual(resolved.reviewer, { kind: "seat", account: HUMAN.toLowerCase() });
    assert.equal(resolved.threshold.minSpend, "250000");
    assert.equal(resolved.threshold.connectorWrites, false);
    assert.equal(resolved.timeoutMs, 30 * 60_000);
  });

  it("a rejection survives a restart too — the effect stays refused", async () => {
    const store = createMemoryRuntimeStore();
    const chat = thread();
    const before = surfaceOn(store, chat);
    await before.set({ scope: { level: "workspace" }, mode: "risky_writes" });
    await before.check(MERGE).catch(() => {});
    const question = chat.messages.find((m) => m.kind === "question")!;
    before.observe(
      chat.post({
        threadId: question.threadId,
        author: MANAGER,
        authorKind: "agent",
        kind: "answer",
        replyTo: question.id,
        body: "reject",
      }),
    );

    const after = surfaceOn(store, chat);
    await after.hydrate();
    const err = await after.check(MERGE).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(isDualControlRefused(err));
    assert.equal((err as { reason: string }).reason, "rejected");
  });

  it("a run that ends closes its reviews, so a late concurrence restarts nothing", async () => {
    const store = createMemoryRuntimeStore();
    const chat = thread();
    const surface = surfaceOn(store, chat);
    await surface.set({ scope: { level: "workspace" }, mode: "risky_writes" });
    await surface.check(MERGE).catch(() => {});

    const closed = await surface.cancelRun("run-1", "operator cancelled");
    assert.equal(closed.length, 1);

    let resumed = 0;
    surface.setResumer(async () => {
      resumed += 1;
    });
    const question = chat.messages.find((m) => m.kind === "question")!;
    surface.observe(
      chat.post({
        threadId: question.threadId,
        author: MANAGER,
        authorKind: "agent",
        kind: "answer",
        replyTo: question.id,
        body: "concur",
      }),
    );
    await surface.drain();
    assert.equal(resumed, 0, "a cancelled run is not restarted by a late answer");
  });

  it("re-asks rather than silently dropping a reply that decided nothing", async () => {
    const store = createMemoryRuntimeStore();
    const chat = thread();
    const surface = surfaceOn(store, chat);
    await surface.set({ scope: { level: "workspace" }, mode: "risky_writes" });
    await surface.check(MERGE).catch(() => {});
    const question = chat.messages.find((m) => m.kind === "question")!;

    surface.observe(
      chat.post({
        threadId: question.threadId,
        author: MANAGER,
        authorKind: "agent",
        kind: "answer",
        replyTo: question.id,
        body: "looks fine to me",
      }),
    );
    // A paused run that no longer shows as waiting is one nobody comes back to.
    assert.equal(chat.messages.filter((m) => m.kind === "question").length, 2);
    assert.equal(surface.reviews()[0]?.status, "pending");
  });
});

describe("dual control from the environment", () => {
  it("is off unless an operator asks for it", () => {
    assert.equal(dualControlFromEnv({}), null);
    assert.equal(dualControlFromEnv({ LACREW_DUAL_CONTROL: "off" }), null);
  });

  it("carries the reviewer and the threshold through", () => {
    const rule = dualControlFromEnv({
      LACREW_DUAL_CONTROL: "spends_and_writes",
      LACREW_DUAL_CONTROL_REVIEWER: `seat:${MANAGER}`,
      LACREW_DUAL_CONTROL_MIN_SPEND: "1000000",
      LACREW_DUAL_CONTROL_TIMEOUT_MIN: "45",
    });
    assert.deepEqual(rule?.reviewer, { kind: "seat", account: MANAGER.toLowerCase() });
    assert.equal(rule?.threshold?.minSpend, "1000000");
    assert.equal(rule?.timeoutMs, 45 * 60_000);
  });

  it("stops the boot on a value it cannot enforce", () => {
    // Better than defaulting: an orchestrator whose reviewer setting silently
    // became `manager` would review to a seat nobody chose.
    assert.throws(() => dualControlFromEnv({ LACREW_DUAL_CONTROL: "sometimes" }), /expected off/);
    assert.throws(
      () =>
        dualControlFromEnv({
          LACREW_DUAL_CONTROL: "risky_writes",
          LACREW_DUAL_CONTROL_REVIEWER: "whoever",
        }),
      /expected manager/,
    );
  });
});
