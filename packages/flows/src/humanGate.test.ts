import assert from "node:assert/strict";
import { test } from "node:test";
import { flow } from "./builder.js";
import { flowToCode } from "./codegen.js";
import { gateAssigneeMatches } from "./humanGate.js";
import { createMockFlowBackend, FlowWaitingError, runFlow } from "./run.js";
import { stepEdges, validateFlow } from "./validate.js";
import type { FlowBackend, FlowDefinition, HumanGateResolution } from "./types.js";

/**
 * Model → human gate → connector write. The write is what the gate is holding:
 * it must not run until someone picks `yes` (PRD F2.27).
 */
const def: FlowDefinition = {
  id: "shortlist-publish",
  name: "Publish the shortlist",
  steps: [
    { id: "draft", kind: "model", prompt: "Draft a shortlist from {{input}}" },
    {
      id: "signoff",
      kind: "human",
      prompt: "Publish this shortlist?\n{{steps.draft.text}}",
      options: [
        { id: "yes", label: "Publish", port: "publish" },
        { id: "no", label: "Skip", port: "memo" },
      ],
      timeoutPort: "memo",
    },
    {
      id: "publish",
      kind: "tool",
      tool: "typefully.create_draft",
      args: { text: "{{steps.draft.text}}" },
      next: null,
    },
    {
      id: "memo",
      kind: "model",
      prompt: "Record that nothing was published.",
      next: null,
    },
  ],
};

/** Answers the gate with `resolution`, or parks the run while it is null. */
function gatedBackend(state: {
  resolution: HumanGateResolution | null;
  calls: string[];
}): FlowBackend {
  return {
    complete: async ({ prompt }) => ({
      text: `text(${prompt.slice(0, 24)})`,
      model: "stub",
    }),
    callTool: async (name, args) => {
      state.calls.push(name);
      if (name === "lacrew_human_gate") {
        if (!state.resolution) {
          throw new FlowWaitingError({
            reason: "human_gate",
            token: "gate_1",
            detail: `waiting on a human at "${String(args.stepId)}"`,
          });
        }
        return state.resolution;
      }
      return { ok: true, name };
    },
  };
}

test("entering the gate parks the run before anything downstream happens", async () => {
  const state = {
    resolution: null as HumanGateResolution | null,
    calls: [] as string[],
  };
  const run = await runFlow(def, gatedBackend(state), {
    input: "venues",
    runId: "run-1",
  });

  assert.equal(run.status, "waiting");
  assert.equal(run.waiting?.reason, "human_gate");
  assert.equal(run.waiting?.token, "gate_1");
  assert.equal(run.waiting?.stepId, "signoff");
  assert.deepEqual(state.calls, ["lacrew_human_gate"], "the write never went out");
  assert.equal(run.resume?.stepId, "signoff");
});

test("answering yes resumes the run down that option's port", async () => {
  const state = {
    resolution: null as HumanGateResolution | null,
    calls: [] as string[],
  };
  const parked = await runFlow(def, gatedBackend(state), {
    input: "venues",
    runId: "run-1",
  });

  state.resolution = {
    outcome: "answered",
    optionId: "yes",
    answeredBy: "seat:dana",
  };
  state.calls.length = 0;
  const resumed = await runFlow(def, gatedBackend(state), {
    runId: parked.runId,
    resume: parked.resume!,
  });

  assert.equal(resumed.status, "completed");
  assert.deepEqual(state.calls, ["lacrew_human_gate", "typefully.create_draft"]);
  assert.deepEqual(
    resumed.steps.map((s) => `${s.stepId}:${s.status}`),
    ["draft:ok", "signoff:waiting", "signoff:ok", "publish:ok"],
  );
  assert.match(
    String(resumed.steps.find((s) => s.stepId === "signoff" && s.status === "ok")?.summary),
    /Publish.*dana/,
  );
});

test("answering no takes the other port and never runs the write", async () => {
  const state = {
    resolution: {
      outcome: "answered",
      optionId: "no",
    } as HumanGateResolution | null,
    calls: [] as string[],
  };
  const run = await runFlow(def, gatedBackend(state), { input: "venues" });

  assert.equal(run.status, "completed");
  assert.equal(run.steps.at(-1)?.stepId, "memo");
  assert.ok(!state.calls.includes("typefully.create_draft"), "the declined write stayed unsent");
});

test("a timeout takes the timeout port, and stops the run when none is declared", async () => {
  const state = {
    resolution: { outcome: "timed_out" } as HumanGateResolution | null,
    calls: [] as string[],
  };
  const routed = await runFlow(def, gatedBackend(state), {});
  assert.equal(routed.status, "completed");
  assert.equal(routed.steps.at(-1)?.stepId, "memo");

  const failsClosed: FlowDefinition = {
    ...def,
    steps: def.steps.map((s) =>
      s.id === "signoff" ? { ...s, timeoutPort: undefined } : s,
    ) as FlowDefinition["steps"],
  };
  const stopped = await runFlow(failsClosed, gatedBackend(state), {});
  assert.equal(stopped.status, "error", "no timeout port means the run stops, not continues");
  assert.match(String(stopped.steps.at(-1)?.error), /human_gate_timeout:signoff/);
  assert.ok(!state.calls.includes("typefully.create_draft"));
});

test("an answer the step never offered routes nowhere", async () => {
  const state = {
    resolution: {
      outcome: "answered",
      optionId: "maybe",
    } as HumanGateResolution | null,
    calls: [] as string[],
  };
  const run = await runFlow(def, gatedBackend(state), {});
  assert.equal(run.status, "error");
  assert.match(String(run.steps.at(-1)?.error), /human_gate_unrecognized:signoff:maybe/);
});

test("the gate's decision is readable by later steps", async () => {
  const withEcho: FlowDefinition = {
    ...def,
    steps: [
      ...def.steps.filter((s) => s.id !== "memo"),
      {
        id: "memo",
        kind: "model",
        prompt: "Decision was {{steps.signoff.text}}",
        next: null,
      },
    ],
  };
  const state = {
    resolution: {
      outcome: "answered",
      optionId: "no",
    } as HumanGateResolution | null,
    calls: [] as string[],
  };
  const run = await runFlow(withEcho, gatedBackend(state), {});
  assert.match(String(run.steps.at(-1)?.summary), /Decision was no/);
});

test("the detached mock parks rather than inventing a decision", async () => {
  const run = await runFlow(def, createMockFlowBackend(), { mocked: true });
  assert.equal(run.status, "waiting");
  assert.equal(run.waiting?.reason, "human_gate");
  assert.match(String(run.waiting?.detail), /no human surface/);
});

test("validation holds the step to prompt, unique options and a sane deadline", () => {
  const bad: FlowDefinition = {
    id: "bad",
    name: "bad",
    steps: [
      {
        id: "gate",
        kind: "human",
        prompt: "  ",
        options: [
          { id: "yes", port: null },
          { id: "YES", port: null },
          { id: "no thanks", port: null },
        ],
        timeoutMs: 1_000,
      },
    ],
  };
  const errors = validateFlow(bad).errors.join(" | ");
  assert.match(errors, /needs a prompt/);
  assert.match(errors, /duplicate option "yes"/);
  assert.match(errors, /must be a word/);
  assert.match(errors, /timeoutMs must be an integer of at least 300000/);

  assert.equal(
    validateFlow({
      id: "empty",
      name: "empty",
      steps: [{ id: "gate", kind: "human", prompt: "?", options: [] }],
    }).ok,
    false,
  );
  assert.equal(validateFlow(def).ok, true);
});

test("an option pointing at a step that does not exist is a validation error", () => {
  const broken: FlowDefinition = {
    ...def,
    steps: def.steps.map((s) =>
      s.id === "signoff"
        ? { ...s, options: [{ id: "yes", port: "nowhere" }], timeoutPort: null }
        : s,
    ) as FlowDefinition["steps"],
  };
  assert.match(validateFlow(broken).errors.join(" | "), /points to unknown step "nowhere"/);
});

test("an option with no port stops the run instead of falling through", () => {
  const step = def.steps.find((s) => s.id === "signoff")!;
  assert.deepEqual(
    stepEdges({
      ...step,
      options: [{ id: "yes" }],
      timeoutPort: undefined,
    } as never),
    [null, null],
  );
});

test("the builder and codegen round-trip a gate", () => {
  const built = flow("sign", "Sign off")
    .human("gate", {
      prompt: "Ship it?",
      options: [
        { id: "yes", label: "Ship", port: "done" },
        { id: "no", port: null },
      ],
      timeoutMs: 30 * 60 * 1000,
      timeoutPort: null,
    })
    .model("done", { prompt: "shipped", next: null })
    .build();

  const code = flowToCode(built);
  assert.match(code, /\.human\("gate", \{[^}]*prompt: "Ship it\?"/);
  assert.match(code, /timeoutMs: 1800000/);
});

/* ——— who may answer an assigned gate (F2.27) ——— */

test("an empty assignee is any human, not nobody", () => {
  // The behaviour every gate shipped with. Reading a blank field as a lock
  // would stop the ones already running.
  assert.equal(gateAssigneeMatches(undefined, { author: "Ada" }), true);
  assert.equal(gateAssigneeMatches("", { author: "Ada" }), true);
  assert.equal(gateAssigneeMatches("   ", { author: "Ada" }), true);
});

test("a named assignee matches the seat id or the name the thread recorded", () => {
  assert.equal(
    gateAssigneeMatches("seat_42", { author: "Ada Lovelace", authorId: "seat_42" }),
    true,
  );
  assert.equal(gateAssigneeMatches("Ada Lovelace", { author: "ada lovelace" }), true);
  assert.equal(gateAssigneeMatches("0xF00D", { author: "0xf00d", authorId: undefined }), true);
  // `seat:` is how the dual-control reviewer spec names one; an operator who
  // wrote it here meant the same seat.
  assert.equal(gateAssigneeMatches("seat:seat_42", { author: "x", authorId: "seat_42" }), true);
});

test("anyone else does not match, and a blank identity never stands in for one", () => {
  assert.equal(
    gateAssigneeMatches("seat_42", { author: "Grace Hopper", authorId: "seat_7" }),
    false,
  );
  assert.equal(gateAssigneeMatches("seat_42", { author: "" }), false);
  // A seat id nobody supplied must not match an assignee that is also blank
  // after normalization — that pairing is checked above and returns true only
  // because the *gate* named nobody, never because the author is anonymous.
  assert.equal(gateAssigneeMatches("seat_42", { author: "  ", authorId: "  " }), false);
});
