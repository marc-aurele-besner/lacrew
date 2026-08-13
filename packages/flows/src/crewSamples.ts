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
 * 2. **It touches nothing of the operator's.** `github-experts` reads a public
 *    pull request on LaCrew's own repo — the one the connector was first
 *    verified against — so firing it needs no repo they own and leaks nothing.
 *    `content-studio` reads nothing at all: its subject is a brief written here,
 *    and the run never leaves LaCrew. `defi-desk` reads nothing either: its
 *    subject is one candidate written here, and no step of it quotes a pool.
 * 3. **Its write path can only refuse.** `bot-pr-triage` may merge, and on a
 *    fresh crew nothing has admitted the merge-authority address, so the flow
 *    asks `lacrew_check_policy`, reads DENY and writes the refusal note.
 *    `content-weekly-brief` asks the same question about a publishing endpoint
 *    its own blueprint leaves off the whitelist, reads DENY and assembles the
 *    human sign-off package. `desk-opportunity-scan` cannot even ask: its own
 *    seat holds no propose tool, so the trade is delegated to the executor,
 *    whose gate reads DENY off a router nobody admitted. That is the
 *    enforcement story working, not a degraded run — and it is why these beat
 *    read-only flows as golden paths: they teach the operator what the crew
 *    cannot do.
 *
 * The certified paths are deliberately different shapes, because the checklist
 * has more than one answer and a suite of one shape would leave the rest
 * unproved on the surface operators read. `github-experts` needs a connector, a
 * credential and an admitted address before its run means anything;
 * `governance-desk` needs a connector that costs nothing to wire, because the
 * surface is public and read-only; `content-studio` and `defi-desk` call
 * nothing outside LaCrew at all, so their checklists report the connector step
 * as *not needed* rather than blocked. `defi-desk` is the only one whose run
 * crosses a seat boundary: the principal that starts it is not the principal
 * that reaches the money, which is the shape a desk actually has.
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
  /**
   * Run input, in the shape the flow reads it.
   *
   * An object for a flow that reads `{{input.<key>}}`, a string for one that
   * reads the whole `{{input}}`. `crewSampleInputText` is what puts it on the
   * wire — `POST /flows/run` takes one string either way.
   */
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
  {
    blueprint: "content-studio",
    flow: "content-weekly-brief",
    // The account brief the pipeline writes for, whole: `content-weekly-brief`
    // reads `{{input}}` rather than keyed fields, because the brief is prose a
    // human writes about a voice and there is no schema for that.
    //
    // LaCrew's own blog, so the fixture describes an account the operator does
    // not have to own — and the run never reaches an account either way.
    input:
      "Account: the LaCrew org blog. Voice: plain and technical, explains the mechanism rather than announcing the news; no hype register, no growth-hacking tone. Never posts: price talk, competitor claims, or a number it cannot source. Themes this week: budgets that live onchain, what an escalation costs the team that raised it, and why a refusal is the product working.",
    summary:
      "Runs the studio's weekly pipeline for one account: shortlist, specialist vote, draft, editor pass, image pack, then the publication question.",
    safety:
      "Nothing leaves LaCrew: every step is model work against a brief written here, and the flow calls no connector route at all. The one write it could attempt is the publication, and this blueprint deliberately leaves the publishing endpoint off the whitelist — so the flow asks policy first, reads DENY, and assembles the human sign-off package instead of posting. Admitting that endpoint is a high-tier proposal both human seats can see, never a side effect of this run.",
  },
  {
    blueprint: "governance-desk",
    flow: "governance-proposal-sweep",
    // Aave's space: large, public, and the one the Snapshot preset was
    // verified against. A space rather than a proposal is the whole point of
    // this fixture — the crew is being asked to find the work, not to reason
    // about work somebody else already found.
    input: { space: "aavedao.eth" },
    summary:
      "Sweeps a public Snapshot space for open proposals, picks the one that needs a decision, and writes the vote instruction with its rationale.",
    safety:
      "The read is one unauthenticated GraphQL query against a public governance forum, so it needs no credential and touches nothing of yours — this is the cheapest certified sample to actually run. Nothing is voted anywhere: the desk holds no key that could sign a Snapshot message and no route on the connector could send one, so the run ends in an instruction for a human rather than a record of a vote. If the space has nothing open the flow says so and hands it to a human, which is the honest answer rather than a manufactured decision.",
  },
  {
    blueprint: "defi-desk",
    flow: "desk-opportunity-scan",
    // One candidate, whole: `desk-opportunity-scan` reads `{{input}}` rather
    // than keyed fields, because what the scanner is handed is whatever the
    // watcher wrote down about a pool, and there is no schema for that.
    //
    // Written to be screenable rather than to be taken: it states a venue, a
    // pair, a size, a depth and an edge, which is exactly what the screen step
    // asks about. A candidate missing the gas line would be passed on for a
    // reason that is about the fixture rather than about the desk.
    input:
      "Candidate: Uniswap v3, USDC/WETH 0.05% pool. Direction USDC→WETH, size 200 USDC. Pool depth around $4.1M with $9.8M of 24h volume, so 200 USDC moves the mid by well under a basis point. Expected edge +0.42% net of gas at ~$0.35 a leg. Max slippage 0.30%, deadline 60s. The venue is on the desk's admitted router list; nothing here has been simulated yet.",
    summary:
      "Runs the scanner's screen on one candidate, writes the route plan, and hands it down to the executor — which is the seat that carries the clip size.",
    safety:
      "The run reads nothing outside LaCrew: the candidate is prose written here, and no step of this flow quotes a pool or calls a venue. The scanner cannot buy anything either — its cap is 5 USDC and its seat holds no propose tool at all, so the trade is delegated to the executor and runs under the executor's own policy stack, never the scanner's. That is where the money would be, and on a crew nobody has finished configuring the router address is not admitted: the executor asks policy before it proposes, reads DENY, and stands down having proposed nothing. A trade over the clip size does not become allowed by being escalated either — it parks as an intent for the risk manager, who approves it inside their own bounds or not at all.",
  },
];

/** The certified sample run for a blueprint, or nothing when it has none. */
export function crewSampleRun(blueprintId: string): CrewSampleRun | undefined {
  return samples.find((s) => s.blueprint === blueprintId);
}

/**
 * The fixture's input as `POST /flows/run` takes it: one string.
 *
 * A flow reading `{{input.<key>}}` wants the JSON body; a flow reading the
 * whole `{{input}}` wants the text, and serializing that one would hand the
 * model a quoted string with its own escapes to read around. The eval harness
 * makes exactly this choice for a scenario's input, so a fixture and the
 * scenario that pins it cannot disagree about what the run was given.
 */
export function crewSampleInputText(sample: CrewSampleRun): string {
  return typeof sample.input === "string" ? sample.input : JSON.stringify(sample.input);
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
 * Flow ids a definition hands work down to, sorted.
 *
 * A delegating step names another flow by id and the runtime resolves it
 * against what is installed, so a run that crosses a seat boundary needs both
 * flows there before it can do anything — `desk-opportunity-scan` reaches the
 * money only through `desk-execute-trade`, and a workspace holding one of them
 * fails at the handoff rather than at install. Read off the steps for the same
 * reason the rest of this module is: a template that gains a handoff gains the
 * requirement in the same commit that added the step.
 *
 * One level, deliberately. This answers "what else must be installed for the
 * certified run", and the engine already refuses a delegation cycle; walking
 * the graph here would duplicate that judgement in a second place.
 */
export function crewFlowDelegates(def: FlowDefinition): string[] {
  const ids = new Set<string>();
  for (const step of def.steps) {
    if (step.kind === "agent" && step.flowId) ids.add(step.flowId);
  }
  return [...ids].sort();
}

/** Every string anywhere in a flow's steps, so a scan cannot miss a nested one. */
function eachStepString(def: FlowDefinition, visit: (text: string) => void): void {
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      visit(value);
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
  eachStepString(def, (text) => {
    for (const m of text.matchAll(INPUT_KEY)) keys.add(m[1]!);
  });
  return [...keys].sort();
}

/**
 * Whether a flow reads the whole `{{input}}` rather than keyed fields.
 *
 * The two shapes want different fixtures — a JSON body against the keys, or the
 * prose a `{{input}}` step interpolates verbatim — and a check that only knew
 * about keys would either wave a whole-input flow through with no input at all
 * or demand fields it never reads.
 */
const WHOLE_INPUT = /\{\{\s*input\s*\}\}/;

export function flowReadsWholeInput(def: FlowDefinition): boolean {
  let found = false;
  eachStepString(def, (text) => {
    if (WHOLE_INPUT.test(text)) found = true;
  });
  return found;
}
