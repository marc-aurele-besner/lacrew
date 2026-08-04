/**
 * The skill packs that ship with LaCrew (PRD F2.23).
 *
 * Each one is the procedure half of a vertical that already exists here: the
 * flows are shipped templates, the connector routes are shipped presets, and
 * every instruction below traces to a step in one of them. That constraint is
 * the whole value — a first-party pack that told an agent to call a route no
 * preset serves would be invention presented as configuration, and the
 * operator reading their directive back would have no way to tell.
 *
 * What the packs deliberately do not carry is `resources`. Which repos, venues
 * or accounts a crew looks after is the operator's answer, exactly as it is for
 * a blueprint (see `crewDirectives.ts`) — a pack that named repositories would
 * be putting somebody else's targets into a directive nobody chose.
 */

import type { SkillPack } from "./skillPacks.js";

/**
 * The github-experts triage procedure.
 *
 * Requires the merge route by name and not just the connector: a GitHub
 * connector registered with reads only is a real and reasonable setup, and a
 * merge procedure installed against it is a procedure that fails at the step
 * that matters.
 */
const githubPrTriage: SkillPack = {
  id: "github-pr-triage",
  version: "1.0.0",
  name: "GitHub PR triage",
  summary:
    "How the github-experts crew works a dependency-bot pull request: triage it, repair it within the allowance, or hand it to a human — and what each of those refuses to do.",
  scope: "agent",
  requires: {
    flows: ["bot-pr-triage", "dep-fix-loop", "merge-window-digest"],
    connectors: ["github.get_pull_request", "github.merge_pull_request"],
  },
  skills: [
    {
      id: "triage-a-bot-pr",
      name: "Triage a dependency-bot PR",
      trigger:
        "A pull request from a dependency bot is open on a repo in your care and nothing has classified it yet.",
      body: [
        'Run the `bot-pr-triage` flow with {"owner":"…","repo":"…","number":N}. It fetches the pull request through the github connector rather than reading a pasted description, so work from what the flow returns.',
        "The classification is one word: MERGE, FIX, HOLD, or REJECT. Majors, edits to CI workflow files, and authors that are not a known bot are never MERGE.",
        "Merging is asked of policy before it is attempted, and the connector re-checks the merge-authority address independently. If the answer is not ALLOW, nothing was merged: say which pull request is waiting and that admitting the merge-authority address is a governance proposal, not a retry.",
      ].join("\n"),
    },
    {
      id: "repair-a-red-pr",
      name: "Repair a red dependency PR",
      trigger:
        "Triage returned FIX, or a bot PR is red on CI and you have been asked whether it can be repaired.",
      body: [
        "Run the `dep-fix-loop` flow with the failing pull request and the CI log excerpt. It diagnoses first — FLAKE, SMALL, LARGE, or SECURITY — and only a SMALL diagnosis spends the patch budget.",
        "There is no retry edge, on purpose. One run is one attempt against one gate, so a fix that does not land is reported and left; re-running the flow to chase green is the runaway the allowance exists to stop.",
        "LARGE and SECURITY are handoffs. Write what you would try first and the blast radius if it goes wrong, and stop there.",
      ].join("\n"),
    },
    {
      id: "write-the-merge-digest",
      name: "Write the merge-window digest",
      trigger:
        "The weekly merge window has closed, or someone asks what the crew merged and what is stuck.",
      body: [
        "Run the `merge-window-digest` flow with the week's merge log. It reads the org chart and the pending escalations itself, so do not summarize either from memory.",
        "Four sections, and no more: what merged, what is blocked and why, spend against the allowance, and the decisions waiting on a human. Name anything pending more than a week.",
      ].join("\n"),
    },
  ],
};

/**
 * The stablecoin-yield procedure behind `yield-rotation-check` and `risk-sweep`.
 *
 * Both flows already call these routes; the pack requires them so an install
 * onto a desk with no market data fails loudly instead of leaving the seat a
 * rotation procedure it cannot carry out.
 */
const stablecoinYieldDesk: SkillPack = {
  id: "stablecoin-yield-desk",
  version: "1.0.0",
  name: "Stablecoin yield desk",
  summary:
    "How a treasury seat checks whether to rotate stablecoin allocation between admitted lending markets, and what it reads before proposing anything.",
  scope: "agent",
  requires: {
    flows: ["yield-rotation-check", "risk-sweep"],
    connectors: ["aave.query", "defillama.get_protocol_tvl", "coingecko.simple_price"],
  },
  skills: [
    {
      id: "check-the-rotation",
      name: "Check whether to rotate",
      trigger:
        "The epoch has fired and the current allocation has not been compared against the admitted markets this epoch, or someone asks whether the desk should move.",
      body: [
        "Run the `yield-rotation-check` flow with the current allocation, the cash floor, and the protocol to read TVL for. It reads the admitted market's reserves and the protocol's TVL before it forms a view.",
        "The verdict is one word: ROTATE, HOLD, or DERISK. A rate you cannot exit is not a rate, and a move that breaks the cash floor is not a move.",
        "The allocation itself is a gate. A size past the clip does not fail — it escalates and waits for the treasury lead onchain, so report it as waiting rather than as refused.",
      ].join("\n"),
    },
    {
      id: "sweep-the-risk",
      name: "Sweep the protocol risk",
      trigger:
        "Before proposing a rotation, and whenever a peg or a protocol's health is questioned.",
      body: [
        "Run the `risk-sweep` flow with the coin ids to price, the protocol to read TVL for, and the account to deactivate if the assessment goes bad.",
        "An unreadable assessment halts the seat that trades the protocol. That is deliberate: a watch that fails open is not a watch, so treat a missing reading as a reason to stop, never as an all-clear.",
      ].join("\n"),
    },
  ],
};

/** Packs LaCrew ships. Installing one is still an operator's explicit act. */
export const firstPartySkillPacks: SkillPack[] = [githubPrTriage, stablecoinYieldDesk];

export function getSkillPack(id: string): SkillPack | undefined {
  return firstPartySkillPacks.find((pack) => pack.id === id);
}
