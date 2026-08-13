/**
 * The DeFi desk's certified first run, across the seat boundary (F2.25).
 *
 * The desk is the only certified path whose run changes principals halfway
 * through: `desk-opportunity-scan` is the scanner's, and the trade it plans
 * belongs to the executor. Everything the path claims lives in that handoff —
 * the scanner never proposes, the executor proposes under its own stack, and a
 * venue nobody admitted is refused there rather than in the flow that found it.
 *
 * None of that is checkable from the parent run alone. A parent whose delegate
 * paid an unadmitted router still reports "delegated, completed", so the
 * assertions here read the **child** run: the verdict its gate got, the receipt
 * it must not have written, and the proposes the whole pair made.
 *
 * The model is scripted rather than memory-stubbed, because both flows route on
 * a one-word answer and a stub falls through to the branch that skips the
 * handoff — which would leave this file green while testing nothing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindCrewFlow,
  crewFlowDelegates,
  crewSampleInputText,
  crewSampleRun,
  getCrewBlueprint,
  getFlowTemplate,
  type FlowDefinition,
} from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { CrewRuntime } from "./runtime.js";
import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./model/index.js";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";

const SCANNER = "0x0000000000000000000000000000000000000051";
const EXECUTOR = "0x0000000000000000000000000000000000000052";
/** The router the plan names. Whether anything admitted it is the scenario. */
const ROUTER = "0x0000000000000000000000000000000000000053";
/** The size the executor's gate proposes: the desk's clip, off the blueprint. */
const CLIP = BigInt(getCrewBlueprint("defi-desk")!.roles.find((r) => r.id === "executor")!.capUsdc);

/** Answers the two routing questions by the words the steps ask for. */
class ScriptedModel implements ModelProvider {
  readonly name = "scripted";
  async complete(input: ModelCompleteInput): Promise<ModelCompleteResult> {
    const text = input.prompt.includes("TRADE or PASS")
      ? "TRADE"
      : input.prompt.includes("SEND or FIX")
        ? "SEND"
        : "noted";
    return { text, model: "scripted", mocked: true };
  }
}

/**
 * The three verdicts, as policy configurations rather than as a stubbed answer.
 *
 * The mock client runs the same whitelist-then-cap stack the modules do, so
 * "DENY" here is a router nobody admitted and "ESCALATE" is a cap below the
 * clip the gate proposes — the states an operator is actually in, not a string
 * this file chose. A stub would keep answering whatever it was told after the
 * stack stopped agreeing with it.
 */
const POLICIES = {
  ALLOW: { whitelist: [ROUTER] as `0x${string}`[], caps: { [EXECUTOR]: CLIP } },
  ESCALATE: { whitelist: [ROUTER] as `0x${string}`[], caps: { [EXECUTOR]: CLIP - 1n } },
  DENY: { whitelist: [] as `0x${string}`[], caps: { [EXECUTOR]: CLIP } },
};

function harness(verdict: keyof typeof POLICIES) {
  const runtime = new CrewRuntime({
    client: createLacrewClient({ useMock: true, policy: POLICIES[verdict] }),
  });
  const surface = createFlowsSurface({
    runtime,
    model: new ScriptedModel(),
    // Any backend flips the surface off its detached mock and onto the live
    // dispatch path, which is where an `agent` step becomes a real child run
    // and a gate reaches the policy stack.
    mcpBackend: {} as McpToolBackend,
    store: createMemoryFlowStore(),
  });
  return { runtime, surface };
}

const sample = crewSampleRun("defi-desk")!;

/** The certified flow and everything it delegates to, bound to real addresses. */
function certifiedFlows(): FlowDefinition[] {
  const bindings = {
    roles: { scanner: SCANNER, executor: EXECUTOR },
    targets: { "dex-router": ROUTER },
  };
  const ids = [sample.flow, ...crewFlowDelegates(getFlowTemplate(sample.flow)!.definition)];
  return ids.map((id) => bindCrewFlow(getFlowTemplate(id)!.definition, bindings));
}

async function fireTheSample(verdict: keyof typeof POLICIES) {
  const h = harness(verdict);
  for (const def of certifiedFlows()) await h.surface.save(def);
  const parent = await h.surface.run({
    id: sample.flow,
    input: crewSampleInputText(sample),
    as: SCANNER,
  });
  const child = h.surface.runs().find((r) => r.flowId === "desk-execute-trade");
  /*
    What the chain side recorded. `AllowanceSpent` is money leaving and
    `IntentCreated` is an escalation parking; both carry the seat that caused
    them, which is how "the scanner never spends" is checkable rather than
    merely stated.

    Read as sets rather than counts. One propose is recorded by both the
    runtime's own recorder and the client's trail, and the offline org ships a
    seeded history besides — so these assertions are about *whose* events exist
    and what they say, never about how many times one of them was written down.
  */
  const audit = await h.runtime.audit();
  const by = (type: string, agent: string) =>
    audit.filter(
      (e) =>
        e.type === type &&
        (e.payload as { agent?: string }).agent?.toLowerCase() === agent.toLowerCase(),
    );
  return {
    ...h,
    parent,
    child,
    spends: by("AllowanceSpent", EXECUTOR),
    intents: by("IntentCreated", EXECUTOR),
    /** Anything the scanner itself caused. The list that must stay empty. */
    scannerMoney: [...by("AllowanceSpent", SCANNER), ...by("IntentCreated", SCANNER)],
  };
}

describe("the defi-desk certified first run", () => {
  it("hands the trade to the executor, and the scanner spends nothing", async () => {
    const { parent, child, spends, scannerMoney } = await fireTheSample("ALLOW");

    assert.equal(parent.status, "completed");
    const ran = parent.steps.map((s) => s.stepId);
    assert.deepEqual(ran, ["screen", "worth-it", "plan", "hand-off", "log"]);
    assert.ok(!ran.includes("pass-note"));

    // The delegation happened at all, and it started a run of its own.
    assert.ok(child, "the handoff started no desk-execute-trade run");
    assert.equal(child.status, "completed");

    /*
      The claim the seat boundary exists for. The money in this pair moved under
      the executor's address — a scanner that reached it would appear in
      `scannerMoney`, which is a different failure from a propose that was
      refused, and the one no policy module would catch.
    */
    assert.deepEqual(scannerMoney, []);
    assert.ok(spends.length > 0, "the delegate never spent, so nothing was proposed at all");
    for (const event of spends) {
      const spend = event.payload as { target: string; value: string };
      assert.equal(spend.target.toLowerCase(), ROUTER.toLowerCase());
      // At the clip size the blueprint gives that seat, not at whatever the
      // candidate asked for.
      assert.equal(spend.value, String(CLIP));
    }
  });

  /*
    Why the flow asks before it proposes, stated as the failure it avoids.
    `EscalationRouter.propose` refuses a DENY by *reverting*, so a gate reached
    at an unadmitted venue fails the step, fails the delegate and fails the
    parent — the certified first run would end in a stack trace rather than the
    refusal it exists to demonstrate. Here that revert is the mock client's
    throw, which is the same shape.

    The refusal's own port is pinned where the verdict can actually be produced:
    deterministically in the eval suite (`defi-desk/unadmitted-venue-stands-down`)
    and against a deployed policy stack by `pnpm golden-path --blueprint
    defi-desk`. In mock mode the runtime answers every `lacrew_check_policy`
    ALLOW without consulting a stack, so a DENY branch driven from here would be
    asserting the mock's shortcut and not the desk.
  */
  it("proposing straight at an unadmitted venue is what a revert looks like", async () => {
    const h = harness("DENY");
    for (const def of certifiedFlows()) await h.surface.save(def);
    await assert.rejects(
      () =>
        h.runtime.propose({
          agent: EXECUTOR as `0x${string}`,
          target: ROUTER as `0x${string}`,
          value: CLIP,
        }),
      /DENY/,
    );
  });

  it("escalates over the clip size instead of trading, and writes the memo", async () => {
    const { child, spends, intents, scannerMoney } = await fireTheSample("ESCALATE");
    const steps = child!.steps.map((s) => s.stepId);
    assert.deepEqual(steps, [
      "preflight",
      "ready",
      "venue-check",
      "admitted",
      "trade",
      "risk-memo",
    ]);
    assert.equal(child!.steps.find((s) => s.stepId === "trade")?.verdict, "ESCALATE");
    assert.ok(!steps.includes("receipt"), "an escalation is a pending intent, not a trade");
    /*
      The check must not read an escalation as a refusal — the ladder is the
      desk's own answer to a trade this size. What it produces is an intent
      waiting for the risk manager, and no money out.
    */
    assert.ok(intents.length > 0, "an escalation that parked no intent approves nothing");
    assert.deepEqual(spends, [], "an escalated trade has not been paid for");
    assert.deepEqual(scannerMoney, []);
  });

  it("files the receipt only when the stack allowed the trade", async () => {
    const { child } = await fireTheSample("ALLOW");
    const steps = child!.steps.map((s) => s.stepId);
    assert.deepEqual(steps, ["preflight", "ready", "venue-check", "admitted", "trade", "receipt"]);
    assert.equal(child!.steps.find((s) => s.stepId === "trade")?.verdict, "ALLOW");
    assert.ok(!steps.includes("stand-down"));
  });
});
