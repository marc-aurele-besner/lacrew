import assert from "node:assert/strict";
import { test } from "node:test";
import { runFlow, stepHasSideEffects } from "./run.js";
import type {
  FlowAttempt,
  FlowAttemptOutcome,
  FlowBackend,
  FlowCheckpoint,
  FlowCheckpointSink,
  FlowDefinition,
} from "./types.js";

/** Read, write, report — the shape a crash mid-write has to be safe against. */
const def: FlowDefinition = {
  id: "pr-triage",
  name: "PR triage",
  steps: [
    { id: "read", kind: "tool", tool: "github.get_pull_request", args: { number: "7" } },
    { id: "merge", kind: "tool", tool: "github.merge_pull_request", args: { number: "7" } },
    { id: "report", kind: "model", prompt: "Merged: {{steps.merge.text}}" },
  ],
};

function backend(calls: string[]): FlowBackend {
  return {
    complete: async ({ prompt }) => ({ text: `report: ${prompt}`, model: "stub" }),
    callTool: async (name) => {
      calls.push(name);
      return { ok: true, name };
    },
  };
}

/** Collects everything the engine wrote, the way a store would. */
function recorder(): {
  sink: FlowCheckpointSink;
  checkpoints: FlowCheckpoint[];
  attempts: Array<{ attempt: FlowAttempt; outcome?: FlowAttemptOutcome }>;
} {
  const checkpoints: FlowCheckpoint[] = [];
  const attempts: Array<{ attempt: FlowAttempt; outcome?: FlowAttemptOutcome }> = [];
  return {
    checkpoints,
    attempts,
    sink: {
      record: async (cp) => {
        checkpoints.push(cp);
      },
      begin: async (attempt) => {
        attempts.push({ attempt });
      },
      settle: async (attempt, outcome) => {
        const open = attempts.find((a) => a.attempt.key === attempt.key && !a.outcome);
        if (open) open.outcome = outcome;
      },
    },
  };
}

test("every completed step writes a checkpoint carrying the cursor", async () => {
  const rec = recorder();
  const run = await runFlow(def, backend([]), { runId: "run-1", checkpoints: rec.sink });

  assert.equal(run.status, "completed");
  assert.deepEqual(
    rec.checkpoints.map((c) => [c.seq, c.stepId, c.nextStepId]),
    [
      [1, "read", "merge"],
      [2, "merge", "report"],
      [3, "report", null],
    ],
  );
  // The cursor is what a resume enters, and it carries the outputs it needs.
  assert.equal(rec.checkpoints[1]?.state?.stepId, "report");
  assert.ok(rec.checkpoints[1]?.state?.outputs.merge, "the merge output rides the checkpoint");
  // The last step has nowhere to resume to, so it carries no state.
  assert.equal(rec.checkpoints[2]?.state, undefined);
  assert.ok(rec.checkpoints.every((c) => c.status === "running"));
});

test("a checkpoint is a snapshot, not a view of the run still moving", async () => {
  const rec = recorder();
  await runFlow(def, backend([]), { runId: "run-snap", checkpoints: rec.sink });

  assert.equal(rec.checkpoints[0]?.state?.steps.length, 1, "the first checkpoint saw one step");
  assert.equal(rec.checkpoints[1]?.state?.steps.length, 2);
});

test("side-effecting steps open and settle an attempt; reads do not", async () => {
  const rec = recorder();
  await runFlow(def, backend([]), { runId: "run-2", checkpoints: rec.sink });

  assert.deepEqual(
    rec.attempts.map((a) => [a.attempt.stepId, a.outcome]),
    [
      ["read", "ok"],
      ["merge", "ok"],
    ],
    "a connector route is assumed to write; the model step is not",
  );
  assert.equal(rec.attempts[0]?.attempt.key, "run-2:read:1");
  assert.equal(rec.attempts[0]?.attempt.idempotent, false);
});

test("stepHasSideEffects is pessimistic about anything it cannot see the far side of", () => {
  assert.equal(stepHasSideEffects({ id: "a", kind: "tool", tool: "lacrew_get_org_tree" }), false);
  assert.equal(stepHasSideEffects({ id: "a", kind: "tool", tool: "lacrew_check_policy" }), false);
  assert.equal(stepHasSideEffects({ id: "a", kind: "tool", tool: "notion.create_page" }), true);
  assert.equal(stepHasSideEffects({ id: "a", kind: "gate", value: "1" }), true);
  assert.equal(stepHasSideEffects({ id: "a", kind: "model", prompt: "hi" }), false);
  assert.equal(
    stepHasSideEffects({ id: "a", kind: "wait" }),
    false,
    "waiting changes nothing outside the run",
  );
});

test("an attempt records the step's own idempotency claim", async () => {
  const rec = recorder();
  const claimed: FlowDefinition = {
    ...def,
    steps: def.steps.map((s) => (s.id === "merge" ? { ...s, idempotent: true } : s)),
  };
  await runFlow(claimed, backend([]), { runId: "run-3", checkpoints: rec.sink });

  const merge = rec.attempts.find((a) => a.attempt.stepId === "merge");
  assert.equal(merge?.attempt.idempotent, true);
});

test("a failed checkpoint fails the run rather than moving past it", async () => {
  const calls: string[] = [];
  const run = await runFlow(def, backend(calls), {
    runId: "run-4",
    checkpoints: {
      record: async (cp) => {
        if (cp.stepId === "read") throw new Error("db down");
      },
    },
  });

  assert.equal(run.status, "error");
  assert.match(String(run.steps.at(-1)?.error), /checkpoint_failed:read/);
  assert.deepEqual(calls, ["github.get_pull_request"], "the write never went out");
});

test("a run with no sink behaves exactly as it did before checkpoints existed", async () => {
  const calls: string[] = [];
  const run = await runFlow(def, backend(calls), { runId: "run-5" });
  assert.equal(run.status, "completed");
  assert.equal(run.steps.length, 3);
});

test("an operator pause parks the run before the next step, not inside one", async () => {
  const calls: string[] = [];
  const rec = recorder();
  const run = await runFlow(def, backend(calls), {
    runId: "run-6",
    checkpoints: rec.sink,
    control: ({ stepId }) => (stepId === "merge" ? "pause" : "continue"),
  });

  assert.equal(run.status, "waiting");
  assert.equal(run.waiting?.reason, "operator");
  assert.equal(run.waiting?.stepId, "merge");
  assert.deepEqual(calls, ["github.get_pull_request"], "the write was never started");
  assert.equal(run.resume?.stepId, "merge");
  // The pause landed between two steps, so the last checkpoint is still the
  // read's — nothing was abandoned half-done.
  assert.equal(rec.checkpoints.at(-1)?.stepId, "read");
});

test("a paused run resumes into the step it stopped before, exactly once", async () => {
  const calls: string[] = [];
  const paused = await runFlow(def, backend(calls), {
    runId: "run-7",
    control: ({ stepId }) => (stepId === "merge" ? "pause" : "continue"),
  });

  calls.length = 0;
  const resumed = await runFlow(def, backend(calls), {
    runId: "run-7",
    resume: paused.resume!,
  });

  assert.equal(resumed.status, "completed");
  assert.deepEqual(calls, ["github.merge_pull_request"], "the read is not replayed");
  assert.deepEqual(
    resumed.steps.map((s) => `${s.stepId}:${s.status}`),
    ["read:ok", "merge:ok", "report:ok"],
  );
});

test("a cancelled run stops without a resume state", async () => {
  const calls: string[] = [];
  const run = await runFlow(def, backend(calls), {
    runId: "run-8",
    control: ({ stepId }) => (stepId === "merge" ? "cancel" : "continue"),
  });

  assert.equal(run.status, "cancelled");
  assert.equal(run.resume, undefined, "a cancelled run is terminal");
  assert.equal(run.waiting, undefined);
  assert.deepEqual(calls, ["github.get_pull_request"]);
});

test("an unreadable control answer lets an already-authorised run continue", async () => {
  const calls: string[] = [];
  const run = await runFlow(def, backend(calls), {
    runId: "run-9",
    control: () => {
      throw new Error("store unreachable");
    },
  });
  assert.equal(run.status, "completed");
});

test("checkpoint sequence continues across a resume rather than restarting", async () => {
  const rec = recorder();
  const paused = await runFlow(def, backend([]), {
    runId: "run-10",
    checkpoints: rec.sink,
    control: ({ stepId }) => (stepId === "merge" ? "pause" : "continue"),
  });

  const after = recorder();
  await runFlow(def, backend([]), {
    runId: "run-10",
    checkpoints: after.sink,
    resume: paused.resume!,
  });

  assert.deepEqual(
    after.checkpoints.map((c) => [c.seq, c.stepId]),
    [
      [2, "merge"],
      [3, "report"],
    ],
    "the run has one sequence, not one per attempt",
  );
});

test("a wait step parks the run and names what would release it", async () => {
  const gated: FlowDefinition = {
    id: "spend-review",
    name: "Spend review",
    steps: [
      { id: "draft", kind: "model", prompt: "Draft: {{input}}" },
      {
        id: "signoff",
        kind: "wait",
        reason: "awaiting_human",
        token: "review-{{input}}",
        detail: "a human signs off before the spend",
      },
      { id: "spend", kind: "gate", value: "1000000" },
    ],
  };
  const calls: string[] = [];
  const rec = recorder();
  const run = await runFlow(gated, backend(calls), {
    input: "42",
    runId: "run-11",
    checkpoints: rec.sink,
  });

  assert.equal(run.status, "waiting");
  assert.equal(run.waiting?.reason, "awaiting_human");
  assert.equal(run.waiting?.token, "review-42", "the token interpolates like any other field");
  assert.equal(run.waiting?.detail, "a human signs off before the spend");
  assert.equal(calls.length, 0, "the gate below the wait never ran");
  assert.equal(rec.checkpoints.at(-1)?.status, "paused");
  assert.equal(rec.checkpoints.at(-1)?.pause?.reason, "awaiting_human");
  assert.equal(rec.checkpoints.at(-1)?.state?.stepId, "signoff");

  const resumed = await runFlow(gated, backend(calls), {
    runId: "run-11",
    resume: run.resume!,
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(calls, ["lacrew_propose_intent"], "resuming released the wait and spent once");
  assert.deepEqual(
    resumed.steps.map((s) => `${s.stepId}:${s.status}`),
    ["draft:ok", "signoff:waiting", "signoff:ok", "spend:ok"],
  );
});

test("a second wait further down still parks the resumed run", async () => {
  const twice: FlowDefinition = {
    id: "two-gates",
    name: "Two gates",
    steps: [
      { id: "first", kind: "wait", detail: "one" },
      { id: "second", kind: "wait", detail: "two" },
      { id: "done", kind: "model", prompt: "done" },
    ],
  };
  const one = await runFlow(twice, backend([]), { runId: "run-12" });
  assert.equal(one.waiting?.stepId, "first");

  const two = await runFlow(twice, backend([]), { runId: "run-12", resume: one.resume! });
  assert.equal(two.status, "waiting");
  assert.equal(two.waiting?.stepId, "second", "the resume releases one wait, not every wait");

  const three = await runFlow(twice, backend([]), { runId: "run-12", resume: two.resume! });
  assert.equal(three.status, "completed");
});
