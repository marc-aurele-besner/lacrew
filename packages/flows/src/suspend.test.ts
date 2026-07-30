import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowWaitingError, isFlowWaiting, runFlow } from "./run.js";
import type { FlowBackend, FlowDefinition } from "./types.js";

/**
 * Three steps: read, write, report. The write is the one that suspends, which
 * is the shape an ask-mode connector call produces (orchestrator F2.24).
 */
const def: FlowDefinition = {
  id: "pr-triage",
  name: "PR triage",
  steps: [
    { id: "read", kind: "tool", tool: "github.get_pull_request", args: { number: "7" } },
    { id: "merge", kind: "tool", tool: "github.merge_pull_request", args: { number: "7" } },
    { id: "report", kind: "model", prompt: "Merged: {{steps.merge.text}}" },
  ],
};

/** Suspends on the merge until `release` is set, then performs it. */
function gatedBackend(state: { released: boolean; calls: string[] }): FlowBackend {
  return {
    complete: async ({ prompt }) => ({ text: `report: ${prompt}`, model: "stub" }),
    callTool: async (name) => {
      state.calls.push(name);
      if (name === "github.merge_pull_request" && !state.released) {
        throw new FlowWaitingError({
          reason: "connector_ask",
          token: "ask_1",
          detail: "waiting on a human to confirm github.merge_pull_request",
        });
      }
      return { ok: true, name };
    },
  };
}

test("a waiting backend suspends the run instead of failing it", async () => {
  const state = { released: false, calls: [] as string[] };
  const run = await runFlow(def, gatedBackend(state), { input: "pr-7", runId: "run-1" });

  assert.equal(run.status, "waiting");
  assert.equal(run.waiting?.reason, "connector_ask");
  assert.equal(run.waiting?.token, "ask_1");
  assert.equal(run.waiting?.stepId, "merge");
  assert.equal(run.steps.at(-1)?.status, "waiting");
  assert.equal(run.steps.at(-1)?.error, undefined, "waiting is not an error");
  assert.deepEqual(state.calls, ["github.get_pull_request", "github.merge_pull_request"]);
  assert.ok(run.resume, "a suspended run carries the state to continue it");
  assert.equal(run.resume?.stepId, "merge");
  assert.equal(run.resume?.input, "pr-7");
});

test("resuming re-enters the suspended step and finishes the run", async () => {
  const state = { released: false, calls: [] as string[] };
  const suspended = await runFlow(def, gatedBackend(state), { input: "pr-7", runId: "run-1" });

  state.released = true;
  state.calls.length = 0;
  const resumed = await runFlow(def, gatedBackend(state), {
    runId: suspended.runId,
    resume: suspended.resume!,
  });

  assert.equal(resumed.status, "completed");
  assert.equal(resumed.runId, "run-1", "the resumed run is the same run");
  assert.equal(resumed.startedAt, suspended.startedAt, "the wait counts as part of the run");
  assert.equal(resumed.input, "pr-7", "the run input survives the suspension");
  // Only the step that suspended re-executes; the read is not repeated.
  assert.deepEqual(state.calls, ["github.merge_pull_request"]);
  const kinds = resumed.steps.map((s) => `${s.stepId}:${s.status}`);
  assert.deepEqual(kinds, ["read:ok", "merge:waiting", "merge:ok", "report:ok"]);
  assert.match(String(resumed.steps.at(-1)?.summary), /report:/);
});

test("a resumed step sees the outputs the earlier steps produced", async () => {
  const state = { released: false, calls: [] as string[] };
  const suspended = await runFlow(def, gatedBackend(state), { runId: "run-2" });
  assert.ok(suspended.resume?.outputs.read, "the read's output rides the resume state");

  state.released = true;
  const resumed = await runFlow(def, gatedBackend(state), {
    runId: "run-2",
    resume: suspended.resume!,
  });
  assert.match(
    String(resumed.steps.at(-1)?.output && (resumed.steps.at(-1)!.output as { text: string }).text),
    /Merged: /,
    "the report step interpolated the merge result rather than an empty string",
  );
});

test("resuming into a step the flow no longer has fails rather than guessing", async () => {
  const state = { released: false, calls: [] as string[] };
  const suspended = await runFlow(def, gatedBackend(state), { runId: "run-3" });

  const edited: FlowDefinition = {
    ...def,
    steps: def.steps.filter((s) => s.id !== "merge"),
  };
  const resumed = await runFlow(edited, gatedBackend(state), {
    runId: "run-3",
    resume: suspended.resume!,
  });
  assert.equal(resumed.status, "error");
  assert.match(String(resumed.steps.at(-1)?.error), /resume_step_missing:merge/);
});

test("an ordinary thrown error is still an error, not a suspension", async () => {
  const backend: FlowBackend = {
    complete: async () => ({ text: "" }),
    callTool: async () => {
      throw new Error("connector_denied:github.merge_pull_request:DENY");
    },
  };
  const run = await runFlow(def, backend, {});
  assert.equal(run.status, "error");
  assert.equal(run.waiting, undefined);
  assert.equal(run.resume, undefined);
});

test("isFlowWaiting matches on the marker, not the prototype", () => {
  assert.ok(isFlowWaiting(new FlowWaitingError({ reason: "connector_ask" })));
  // What a second copy of this package in the same process would produce.
  assert.ok(isFlowWaiting({ __flowWaiting: true, reason: "connector_ask", message: "x" }));
  assert.equal(isFlowWaiting(new Error("connector_ask")), false);
  assert.equal(isFlowWaiting({ __flowWaiting: true }), false);
});
