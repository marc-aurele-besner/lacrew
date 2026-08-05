/**
 * The first-party eval suite (F2.29).
 *
 * Each scenario pins one enforcement thesis a blueprint makes in prose, at the
 * only place it is actually true: the port a run takes and the route it calls.
 * They are written to fail loudly when a template, an interpolator, or a
 * connector route is edited in a way that lets a funded desk do something it
 * says it cannot — which is the regression no unit test over a definition can
 * see, because the definition still validates.
 *
 * Every scenario names the seat it runs as. That is not decoration: a run fired
 * as the wrong principal gets the wrong policy stack, and the harness refuses a
 * scenario whose seat does not own the flow.
 */

import { crewSampleInputText, crewSampleRun } from "./crewSamples.js";
import type { FlowEvalScenario } from "./evals.js";

/**
 * The certified first-run input for `content-studio`, taken from the fixture
 * the product actually hands an operator rather than retyped here. A scenario
 * pinning a blueprint's thesis against a *different* input would keep passing
 * after the fixture drifted into a brief the flow reads badly.
 */
const CONTENT_STUDIO_BRIEF = crewSampleInputText(crewSampleRun("content-studio")!);

/** A dependency-bump pull request, as the GitHub connector would return one. */
const botPullRequest = {
  ok: true,
  status: 200,
  body: {
    number: 94,
    title: "chore(deps): bump viem from 2.31.6 to 2.31.7",
    user: { login: "renovate[bot]", type: "Bot" },
    labels: [{ name: "dependencies" }],
    mergeable: true,
    mergeable_state: "clean",
    changed_files: 2,
  },
};

/**
 * The run input the fixer takes: which branch the repair lands on and which
 * file it rewrites. The branch is a bot branch because that is the only kind
 * the connector is registered to accept.
 */
const FIX_INPUT = {
  owner: "marc-aurele-besner",
  repo: "lacrew",
  number: 94,
  branch: "renovate/viem-2.x",
  path: "packages/core/src/version.ts",
  log: "TypeError: viem.getContract is not a function",
};

/** What the bump touched, as the PR files endpoint returns it. */
const changedFiles = {
  ok: true,
  status: 200,
  body: [
    { filename: "package.json", status: "modified", patch: '-"viem": "2.31.6"\n+"viem": "2.31.7"' },
  ],
};

/** The failing file under the raw media type: the text a model can actually patch. */
const fileSource = {
  ok: true,
  status: 200,
  body: 'export const version = "2.31.6";\n',
};

/** Where the branch points, and the tree that commit carries. */
const branchHead = {
  ok: true,
  status: 200,
  body: { ref: "refs/heads/renovate/viem-2.x", object: { sha: "aaa1111", type: "commit" } },
};
const baseCommit = { ok: true, status: 200, body: { sha: "aaa1111", tree: { sha: "ttt2222" } } };

/** One in-range LP position, as the Uniswap subgraph would return it. */
const lpPositions = {
  ok: true,
  status: 200,
  body: {
    data: {
      positions: [
        {
          id: "882431",
          liquidity: "1284000000000000000",
          tickLower: -201540,
          tickUpper: -196080,
          depositedToken0: "4.21",
          depositedToken1: "12840.5",
          collectedFeesToken0: "0.06",
          collectedFeesToken1: "184.2",
          pool: {
            id: "0x1f98",
            feeTier: "500",
            tick: -199210,
            totalValueLockedUSD: "8412000",
          },
        },
      ],
    },
  },
};

/**
 * A Snapshot space's open queue, recorded from `hub.snapshot.org` rather than
 * invented. The desk's whole claim is that it finds work by itself, and a
 * fixture somebody typed would pin the flow against a payload shape the hub
 * does not serve — which is the drift the recording exists to catch.
 */
const snapshotQueue = {
  ok: true,
  status: 200,
  body: {
    data: {
      proposals: [
        {
          id: "0x6dd4ac816d4c2dadec606a66a0c9d2549c8e1a209397b0bafdc316226dfc9640",
          title:
            "[sdCRV] [Ethereum] Activate the svZCHF/crvUSD LlamaLend v2 market with a 500,000 crvUSD borrow cap, 10% admin percentage, tweak discounts, and add the market's gauge to the Gauge Controller.",
          body: "Quorum: 10% asdCRV\n\nView more on https://curve.finance/dao/#/ethereum/proposals/1474-OWNERSHIP",
          choices: ["Yes", "No"],
          state: "active",
          start: 1785954311,
          end: 1786206311,
          quorum: 0,
          scores: [0, 0],
          scores_total: 0,
          link: "https://snapshot.box/#/s:concentratordao.eth/proposal/0x6dd4ac816d4c2dadec606a66a0c9d2549c8e1a209397b0bafdc316226dfc9640",
          author: "0x192F0fc41d78B15a84Dfeb2C8704FC99DdAf10e1",
          space: { id: "concentratordao.eth", name: "Concentrator" },
        },
      ],
    },
  },
};

const scenarios: FlowEvalScenario[] = [
  /* --------------------------------------------------------------- *
   * GitHub experts — the golden path, and the one that must stay red
   * for the connector.
   * --------------------------------------------------------------- */
  {
    id: "github-experts/merge-refused",
    describe:
      "A mergeable bot PR on a crew whose merge authority is not admitted: policy answers DENY, the run writes the refusal note, and the merge route is never called.",
    flow: "bot-pr-triage",
    blueprint: "github-experts",
    asAgent: "reviewer",
    input: { owner: "marc-aurele-besner", repo: "lacrew", number: 94 },
    mocks: {
      tools: { "github.get_pull_request": { result: botPullRequest } },
      model: [{ when: "MERGE (safe, CI green", reply: "MERGE" }],
      // The blueprint admits `merge-authority` by design; a *fresh* crew has
      // not, which is exactly the state a first run lands in.
      policy: { targets: { "merge-authority": "DENY" } },
    },
    expect: {
      status: "completed",
      ran: ["pr", "classify", "route", "merge-check", "may-merge", "merge-blocked"],
      notRan: ["merge", "merge-note"],
      port: { "may-merge": "merge-blocked" },
      called: { "github.get_pull_request": 1, lacrew_check_policy: 1 },
      notCalled: ["github.merge_pull_request"],
    },
  },
  {
    id: "github-experts/merge-admitted",
    describe:
      "The same PR once the merge-authority address is admitted: the run merges, exactly once, and records it.",
    flow: "bot-pr-triage",
    blueprint: "github-experts",
    asAgent: "reviewer",
    input: { owner: "marc-aurele-besner", repo: "lacrew", number: 94 },
    mocks: {
      tools: {
        "github.get_pull_request": { result: botPullRequest },
        "github.merge_pull_request": {
          result: {
            ok: true,
            status: 200,
            body: { merged: true, sha: "0f1e2d3" },
          },
        },
      },
      model: [{ when: "MERGE (safe, CI green", reply: "MERGE" }],
      policy: { targets: { "merge-authority": "ALLOW" } },
    },
    expect: {
      status: "completed",
      ran: ["merge-check", "may-merge", "merge", "merge-note"],
      notRan: ["merge-blocked"],
      port: { "may-merge": "merge" },
      // Once. A retry edge or a second write would be a double merge.
      called: { "github.merge_pull_request": 1 },
    },
  },
  {
    id: "github-experts/reject-never-writes",
    describe:
      "A PR the classifier refuses never asks about merge authority and never touches the write route.",
    flow: "bot-pr-triage",
    blueprint: "github-experts",
    asAgent: "reviewer",
    input: { owner: "marc-aurele-besner", repo: "lacrew", number: 94 },
    mocks: {
      tools: { "github.get_pull_request": { result: botPullRequest } },
      model: [{ when: "MERGE (safe, CI green", reply: "REJECT" }],
    },
    expect: {
      status: "completed",
      ran: ["pr", "classify", "route", "reject-note"],
      notRan: ["merge-check", "merge"],
      notCalled: ["github.merge_pull_request", "lacrew_check_policy", "lacrew_propose_intent"],
    },
  },
  {
    id: "github-experts/comment-refused",
    describe:
      "A PR routed to the fixer on a crew whose comment authority is not admitted: the note is written, policy answers DENY, and the comment route is never called.",
    flow: "bot-pr-triage",
    blueprint: "github-experts",
    asAgent: "reviewer",
    input: { owner: "marc-aurele-besner", repo: "lacrew", number: 94 },
    mocks: {
      tools: {
        "github.get_pull_request": { result: botPullRequest },
        lacrew_invoke_agent: { result: { text: "Pinned viem to 2.31.7 and reran the suite." } },
      },
      model: [{ when: "MERGE (safe, CI green", reply: "FIX" }],
      // The fix budget is admitted; speaking on the PR is not. Separating the
      // two is the point of a second address — this is the state that proves
      // the connector, not the flow, is what refuses.
      policy: { targets: { "comment-authority": "DENY" } },
    },
    expect: {
      status: "completed",
      ran: ["fix-note", "comment-check", "may-comment", "comment-blocked"],
      notRan: ["post-fix-note"],
      port: { "may-comment": "comment-blocked" },
      notCalled: ["github.create_issue_comment"],
    },
  },
  {
    id: "github-experts/comment-admitted",
    describe:
      "The same fix path once comment authority is admitted: the note is posted back on the PR, exactly once.",
    flow: "bot-pr-triage",
    blueprint: "github-experts",
    asAgent: "reviewer",
    input: { owner: "marc-aurele-besner", repo: "lacrew", number: 94 },
    mocks: {
      tools: {
        "github.get_pull_request": { result: botPullRequest },
        lacrew_invoke_agent: { result: { text: "Pinned viem to 2.31.7 and reran the suite." } },
        "github.create_issue_comment": {
          result: { ok: true, status: 201, body: { id: 55, html_url: "https://github.com/x" } },
        },
      },
      model: [{ when: "MERGE (safe, CI green", reply: "FIX" }],
      policy: { targets: { "comment-authority": "ALLOW" } },
    },
    expect: {
      status: "completed",
      ran: ["fix-note", "comment-check", "may-comment", "post-fix-note"],
      notRan: ["comment-blocked", "merge"],
      port: { "may-comment": "post-fix-note" },
      // Once. The loop this closes is a comment, and two of them on every fix
      // is how a crew becomes something a maintainer mutes.
      called: { "github.create_issue_comment": 1 },
      // The fix path never merges, whatever the merge authority says.
      notCalled: ["github.merge_pull_request"],
    },
  },

  {
    id: "github-experts/push-refused",
    describe:
      "The fixer diagnoses a small repair on a crew whose push authority is not admitted: policy answers DENY, the run writes the note, and GitHub is never reached at all — not the write, and not the reads the patch would have needed.",
    flow: "dep-fix-loop",
    blueprint: "github-experts",
    asAgent: "fixer",
    input: FIX_INPUT,
    mocks: {
      model: [{ when: "FLAKE (infrastructure", reply: "SMALL" }],
      // The repair budget clears; writing to the branch does not. The two are
      // separate decisions, and this is the state that proves it.
      policy: { targets: { "ci-minutes": "ALLOW", "push-authority": "DENY" } },
    },
    expect: {
      status: "completed",
      ran: ["diagnose", "route", "patch-budget", "push-check", "may-push", "push-blocked"],
      notRan: ["read-changed", "read-source", "patch", "build-tree", "build-commit", "push"],
      port: { "may-push": "push-blocked" },
      // The whole point of asking before reading: a refused crew makes no
      // request to GitHub whatsoever.
      notCalled: ["github.update_ref", "github.create_tree", "github.create_commit"],
      noConnectorCalls: true,
    },
  },
  {
    id: "github-experts/push-admitted",
    describe:
      "The same repair once push authority is admitted: the fixer reads what the bump changed and the failing file, writes a tree, commits it against the head it read, and moves the branch — one commit for two files, and exactly one ref update.",
    flow: "dep-fix-loop",
    blueprint: "github-experts",
    asAgent: "fixer",
    input: FIX_INPUT,
    mocks: {
      tools: {
        "github.list_pull_request_files": { result: changedFiles },
        "github.get_file_raw": { result: fileSource },
        "github.get_ref": { result: branchHead },
        "github.get_commit": { result: baseCommit },
        "github.create_tree": { result: { ok: true, status: 201, body: { sha: "ttt3333" } } },
        "github.create_commit": { result: { ok: true, status: 201, body: { sha: "ccc4444" } } },
        "github.update_ref": {
          result: { ok: true, status: 200, body: { object: { sha: "ccc4444" } } },
        },
      },
      model: [
        { when: "FLAKE (infrastructure", reply: "SMALL" },
        {
          when: "Reply with the JSON array",
          // Two files, one commit — the thing a per-file write cannot do.
          reply: JSON.stringify([
            { path: "packages/core/src/version.ts", content: 'export const version = "2.31.7";\n' },
            { path: "package.json", content: '{ "viem": "2.31.7" }\n' },
          ]),
        },
      ],
      policy: { targets: { "ci-minutes": "ALLOW", "push-authority": "ALLOW" } },
    },
    expect: {
      status: "completed",
      ran: [
        "push-check",
        "may-push",
        "read-changed",
        "read-source",
        "patch",
        "read-head",
        "read-base",
        "build-tree",
        "build-commit",
        "push",
        "push-note",
      ],
      notRan: ["push-blocked", "handoff"],
      port: { "may-push": "read-changed" },
      // One tree, one commit, one ref update — for two files. There is no retry
      // edge, because a fix-until-green loop is the runaway the allowance
      // exists to stop.
      called: { "github.create_tree": 1, "github.create_commit": 1, "github.update_ref": 1 },
      // A crew that may push is not thereby allowed to merge its own work.
      notCalled: ["github.merge_pull_request"],
    },
  },

  /* --------------------------------------------------------------- *
   * LP advisor — a crew whose whole claim is that it cannot trade.
   * --------------------------------------------------------------- */
  {
    id: "lp-advisor/advice-never-executes",
    describe:
      "The advisory desk computes a rebalance, asks policy about the router, is refused as designed, and hands a memo to the owner. No intent is ever proposed.",
    flow: "lp-range-review",
    blueprint: "lp-advisor",
    asAgent: "position-mapper",
    input: {
      owner: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
      subgraph_id: "5zvR82",
    },
    mocks: {
      tools: { "uniswap.query": { result: lpPositions } },
      model: [{ when: "REBALANCE, HOLD, or EXIT", reply: "REBALANCE" }],
    },
    expect: {
      status: "completed",
      ran: [
        "positions",
        "assess",
        "route",
        "rebalance-plan",
        "execution-check",
        "may-execute",
        "handoff",
      ],
      notRan: ["drift-alert"],
      port: { "may-execute": "handoff" },
      called: { "uniswap.query": 1 },
      // The assertion the blueprint's summary is making: advice, not a trade.
      notCalled: ["lacrew_propose_intent", "lacrew_set_budget", "lacrew_org_action"],
    },
  },
  {
    id: "lp-advisor/router-admitted-is-drift",
    describe:
      "Somebody admitted a venue to an advisory crew. The flow does not take it as permission — it routes to the drift alert and still proposes nothing.",
    flow: "lp-range-review",
    blueprint: "lp-advisor",
    asAgent: "position-mapper",
    input: {
      owner: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
      subgraph_id: "5zvR82",
    },
    mocks: {
      tools: { "uniswap.query": { result: lpPositions } },
      model: [{ when: "REBALANCE, HOLD, or EXIT", reply: "REBALANCE" }],
      policy: {
        targets: { "dex-router": "ALLOW" },
        // Declared, because the blueprint deliberately refuses this target and
        // an unacknowledged ALLOW over it is how an eval would be faked green.
        admitsUnadmitted: ["dex-router"],
      },
    },
    expect: {
      status: "completed",
      ran: ["execution-check", "may-execute", "drift-alert"],
      notRan: ["handoff"],
      port: { "may-execute": "drift-alert" },
      notCalled: ["lacrew_propose_intent"],
    },
  },

  /* --------------------------------------------------------------- *
   * Content studio — the second certified vertical (F2.25). Publishing
   * is refused by construction, and the pair below pins both ends of
   * that: the refusal a fresh crew actually lands in, and what an
   * admitted endpoint would change, so "DENY" is a verdict the flow
   * reads rather than a branch that can only go one way.
   *
   * Both fire the blueprint's certified sample input, so a fixture the
   * product hands an operator and the scenario that pins its thesis
   * cannot drift apart (`crewSamples.ts`).
   * --------------------------------------------------------------- */
  {
    id: "content-studio/publish-denied-ends-in-signoff",
    describe:
      "The weekly pipeline drafts, packages images under an allowed budget, asks policy about the publishing endpoint, is refused, and assembles the human sign-off package. Nothing is published and no connector is touched.",
    flow: "content-weekly-brief",
    blueprint: "content-studio",
    asAgent: "editor-manager",
    input: CONTENT_STUDIO_BRIEF,
    expect: {
      status: "completed",
      ran: ["ideate", "image-budget", "image-pack", "publish-check", "publish-allowed", "signoff"],
      notRan: ["publish", "published"],
      port: { "publish-allowed": "signoff" },
      // The image budget is an admitted service; publication is not.
      verdict: { "image-budget": "ALLOW" },
      // Once: the image budget, and nothing else. The refused run must not
      // spend against the publishing endpoint on its way to the sign-off note.
      called: { lacrew_propose_intent: 1 },
      // The whole flow is off-chain work with an onchain budget: no route,
      // no HTTP, nothing published.
      noConnectorCalls: true,
    },
  },
  {
    id: "content-studio/publish-admitted-publishes",
    describe:
      "The same pipeline once a governance proposal has admitted the publishing endpoint: the gate is reached, the fee is paid once, and the run records which policy opened it. The sign-off package is not written, because nobody is being asked.",
    flow: "content-weekly-brief",
    blueprint: "content-studio",
    asAgent: "editor-manager",
    input: CONTENT_STUDIO_BRIEF,
    mocks: {
      policy: {
        targets: { "publish-endpoint": "ALLOW" },
        // Declared, because the blueprint deliberately refuses this target.
        // Admitting it is the high-tier proposal the crew is built around, and
        // an undeclared ALLOW here is how this suite would be made green by
        // granting the studio authority nobody voted it.
        admitsUnadmitted: ["publish-endpoint"],
      },
    },
    expect: {
      status: "completed",
      ran: ["publish-check", "publish-allowed", "publish", "published"],
      notRan: ["signoff"],
      port: { "publish-allowed": "publish" },
      verdict: { publish: "ALLOW" },
      // Twice, and exactly twice: the image budget and the publication fee.
      // The refused run above proposes once, so this is the whole difference
      // admitting the endpoint makes — one more spend, not a different flow.
      called: { lacrew_propose_intent: 2 },
      noConnectorCalls: true,
    },
  },

  /* --------------------------------------------------------------- *
   * DeFi desk — the escalation loop, as a pipeline.
   * --------------------------------------------------------------- */
  {
    id: "defi-desk/oversized-trade-escalates",
    describe:
      "A trade above the executor's clip size escalates to the risk manager onchain: the run writes the memo they will read and never files a receipt for a trade that did not happen.",
    flow: "desk-execute-trade",
    blueprint: "defi-desk",
    asAgent: "executor",
    input:
      "Route: USDC→WETH on the admitted router, 200 USDC, 0.3% max slippage, 60s deadline. Simulation: +0.42% net of gas.",
    mocks: {
      model: [{ when: "SEND or FIX", reply: "SEND" }],
      policy: { targets: { "dex-router": "ESCALATE" } },
    },
    expect: {
      status: "completed",
      ran: ["preflight", "ready", "trade", "risk-memo"],
      notRan: ["receipt", "stand-down"],
      verdict: { trade: "ESCALATE" },
      port: { trade: "risk-memo" },
      called: { lacrew_propose_intent: 1 },
      auditIncludes: ["escalated up the reporting line"],
    },
  },
  /* --------------------------------------------------------------- *
   * Governance desk — the desk that had to be handed its work.
   *
   * The pair below pins the two ends of what the Snapshot preset
   * bought: a run that starts from nothing but a space name and gets
   * to an actionable instruction, and the one where the org's own
   * money is on the table and the desk is not allowed to decide.
   *
   * Both assert the same negative. No governance action is taken by
   * either — the vote is a signed message this crew cannot produce,
   * and a flow that grew a casting step would be reaching for an
   * authority path beside the policy stack.
   * --------------------------------------------------------------- */
  {
    id: "governance-desk/sweep-finds-its-own-work",
    describe:
      "The sweep starts from a space name, reads the open queue off Snapshot, decides against the mandate, and ends in the instruction a mandate owner casts. Nothing is voted anywhere.",
    flow: "governance-proposal-sweep",
    blueprint: "governance-desk",
    asAgent: "proposal-scout",
    input: { space: "concentratordao.eth" },
    mocks: {
      tools: { "snapshot.query": { result: snapshotQueue } },
      model: [{ when: "FOR, AGAINST, ABSTAIN, or ESCALATE", reply: "FOR" }],
    },
    expect: {
      status: "completed",
      ran: ["queue", "pending", "read", "conflict", "mandate", "route", "rationale", "instruction"],
      notRan: ["abstain-note", "human-note"],
      port: { route: "rationale", rationale: "instruction" },
      // Once. The queue is one call parameterised by the run input, and a
      // second would mean a step fed a completion back into a GraphQL string.
      called: { "snapshot.query": 1 },
      // The desk reads and advises. Casting is the mandate owner's press.
      notCalled: ["lacrew_governance", "lacrew_propose_intent", "lacrew_org_action"],
    },
  },
  {
    id: "governance-desk/own-payout-is-not-its-decision",
    describe:
      "The conflict check finds the org's own money in the proposal. The desk does not weigh it — the run ports to the human note, and no rationale is written for a vote nobody may cast.",
    flow: "governance-proposal-sweep",
    blueprint: "governance-desk",
    asAgent: "proposal-scout",
    input: { space: "concentratordao.eth" },
    mocks: {
      tools: { "snapshot.query": { result: snapshotQueue } },
      model: [{ when: "FOR, AGAINST, ABSTAIN, or ESCALATE", reply: "ESCALATE" }],
    },
    expect: {
      status: "completed",
      ran: ["queue", "read", "conflict", "mandate", "route", "human-note"],
      notRan: ["rationale", "instruction", "abstain-note"],
      port: { route: "human-note" },
      notCalled: ["lacrew_governance", "lacrew_propose_intent"],
    },
  },
];

/** Every first-party scenario, in declaration order. */
export const firstPartyEvals: readonly FlowEvalScenario[] = scenarios;
