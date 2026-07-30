/**
 * Sample runs: the fixture that turns a stood-up crew into a crew that has
 * done something.
 *
 * A blueprint install ends with seats, budgets and flows and no evidence any of
 * it works. The gap is not knowledge, it is a *run input*: `bot-pr-triage`
 * wants `{"owner":"…","repo":"…","number":7}` and an operator who has never
 * seen the flow has to read the definition to learn that. So a certified path
 * ships the input with the blueprint, and the product fires it.
 *
 * Three rules keep a fixture from becoming a lie:
 *
 * 1. **It runs the real flow against the real runtime.** There is no sample
 *    mode. A fixture is a run input and nothing else — same principal, same
 *    policy stack, same connector. If the model key is missing the run returns
 *    stub text and the caller must say so; a fixture that quietly swapped in a
 *    canned result would be the exact "Mocked success presented as live" this
 *    path exists to avoid.
 * 2. **It points at something public.** The subject is a public pull request on
 *    LaCrew's own repo, so firing it needs no repo the operator owns and leaks
 *    nothing. It is also the PR the connector was first verified against.
 * 3. **Its write path can only refuse.** `bot-pr-triage` may merge, and on a
 *    fresh crew nothing has admitted the merge-authority address, so the flow
 *    asks `lacrew_check_policy`, reads DENY and writes the refusal note. That
 *    is the enforcement story working, not a degraded run — and it is why this
 *    flow is the golden path rather than a read-only one that would teach the
 *    operator nothing about what the crew cannot do.
 *
 * Not every blueprint has one, and `crewSampleRun` returns `undefined` rather
 * than inventing an input. A surface with no fixture should say the blueprint
 * has no certified sample yet, not fabricate a plausible-looking JSON body.
 */

import { getFlowTemplate } from "./templates.js";
import type { CrewBlueprint, CrewRole } from "./crews.js";
import type { FlowDefinition } from "./types.js";

export type CrewSampleRun = {
  /** Blueprint id this fixture stands the golden path up for. */
  blueprint: string;
  /** Flow definition id it runs. Must be a flow the blueprint ships. */
  flow: string;
  /** Run input, exactly as the orchestrator's `POST /flows/run` takes it. */
  input: unknown;
  /** What the run does, in the operator's terms. */
  summary: string;
  /**
   * Why firing this at a crew nobody has finished configuring is safe: what it
   * reads, what it could write, and what stops the write.
   */
  safety: string;
};

const samples: CrewSampleRun[] = [
  {
    blueprint: "github-experts",
    flow: "bot-pr-triage",
    // A merged pull request on the public LaCrew repo: the one the GitHub
    // connector was first verified against. Merged rather than open on
    // purpose — a sample that triaged a live PR would be reasoning about
    // somebody's in-flight work, and the flow's own merge path is refused
    // either way.
    input: { owner: "marc-aurele-besner", repo: "lacrew", number: 94 },
    summary:
      "Reads one public pull request through the GitHub connector, classifies it, and routes the verdict.",
    safety:
      "The pull request is public and already merged, so the read touches nothing of yours. If the crew classifies it as mergeable the flow asks policy about the merge-authority address first — on a new crew nothing has admitted that address, so the answer is DENY and the run writes the refusal note instead of merging. Admitting it is a governance proposal, never a side effect of this run.",
  },
];

/** The certified sample run for a blueprint, or nothing when it has none. */
export function crewSampleRun(blueprintId: string): CrewSampleRun | undefined {
  return samples.find((s) => s.blueprint === blueprintId);
}

/** Every certified sample, in registry order. */
export const crewSampleRuns: readonly CrewSampleRun[] = samples;

/**
 * The seat a flow runs as.
 *
 * Derived from the blueprint rather than stored on the fixture: a role's
 * `flows` list is already the statement of who owns a pipeline, and a second
 * copy would be free to disagree with it. A run fired as the wrong principal
 * gets the wrong policy stack, which is the difference between a spend that
 * escalates to a manager and one that never should have been attempted.
 */
export function crewFlowOwner(bp: CrewBlueprint, flowId: string): CrewRole | undefined {
  return bp.roles.find((role) => (role.flows ?? []).includes(flowId));
}

/**
 * What has to be wired before a flow can do more than think.
 *
 * Read off the definition's own steps, so a flow that gains a connector call
 * gains the requirement in the same commit. `model` is true for any flow with a
 * completion step: without a key those steps return the orchestrator's stub,
 * and a classifier reading stub text falls through to its default branch — the
 * run "succeeds" and means nothing.
 */
export type CrewSampleNeeds = {
  model: boolean;
  /** Connector ids the flow's tool steps call, sorted, without route names. */
  connectors: string[];
};

export function crewFlowNeeds(def: FlowDefinition): CrewSampleNeeds {
  const connectors = new Set<string>();
  let model = false;
  for (const step of def.steps) {
    if (step.kind === "model") model = true;
    if (step.kind !== "tool") continue;
    // `lacrew_*` is the orchestrator's own MCP surface; everything else is
    // `<connector>.<route>` and needs registering before it resolves.
    if (step.tool.startsWith("lacrew_")) continue;
    const dot = step.tool.indexOf(".");
    if (dot > 0) connectors.add(step.tool.slice(0, dot));
  }
  return { model, connectors: [...connectors].sort() };
}

/** `crewFlowNeeds` for a sample, resolved through the template catalog. */
export function crewSampleNeeds(sample: CrewSampleRun): CrewSampleNeeds | undefined {
  const def = getFlowTemplate(sample.flow)?.definition;
  return def ? crewFlowNeeds(def) : undefined;
}

/**
 * `{{input.<key>}}` keys a flow reads, sorted.
 *
 * Used to hold a fixture to its flow: a step that starts reading `input.branch`
 * must not leave the sample supplying three of four fields and failing at the
 * connector with a missing path argument.
 */
const INPUT_KEY = /\{\{\s*input\.([\w-]+)\s*\}\}/g;

export function flowInputKeys(def: FlowDefinition): string[] {
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(INPUT_KEY)) keys.add(m[1]!);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(def.steps);
  return [...keys].sort();
}
