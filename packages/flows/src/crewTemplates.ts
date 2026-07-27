/**
 * Flow templates for the crew blueprints (`crews.ts`).
 *
 * Each one is a pipeline a design partner described in their intake, written so
 * the money in it rides the policy stack rather than a promise: the DeFi desk's
 * clip size is a gate, and the fixer's retry budget is a gate. The content
 * crew's publish step *asks* policy first, because its endpoint is deliberately
 * unadmitted — a propose against a target the run's session key does not cover
 * reverts onchain, and a reverted run never reaches the human handoff that was
 * the whole point. Asking returns DENY and the flow routes on it.
 *
 * Seats and targets appear as `{{crew.<role>}}` / `{{target.<id>}}` because a
 * template cannot know addresses that only exist once the crew is hired.
 * `bindCrewFlow` resolves them at install time and throws on anything unbound.
 *
 * Where a step routes on a model's answer, the model is asked for exactly one
 * word and the edge compares for equality. `switch` matches the whole resolved
 * output, and a `contains` branch would match "do not SEND" as readily as
 * "SEND", so reasoning is written by a later step where prose belongs.
 */

import { flow } from "./builder.js";
import type { FlowTemplate } from "./types.js";

/* ------------------------------------------------------------------ *
 * DeFi desk (design-partners/01-defi-opportunistic-trading.md)
 * ------------------------------------------------------------------ */

const deskOpportunityScan: FlowTemplate = {
  id: "tpl-desk-opportunity-scan",
  name: "Desk: opportunity scan",
  description:
    "The scanner screens one candidate, writes the route plan, and hands it to the executor. The scanner never proposes the trade itself — its own cap would refuse the size, and that is the point.",
  category: "trading",
  author: "LaCrew",
  definition: flow("desk-opportunity-scan", "Desk: opportunity scan")
    .describe(
      "Run input is one candidate: venue, pair, expected PnL, gas estimate. Runs as the scanner. The trade is delegated to the executor, which has the clip-size cap and runs under its own policy stack — a flow cannot borrow authority by delegating upward.",
    )
    .source({ templateId: "tpl-desk-opportunity-scan", author: "LaCrew" })
    .model("screen", {
      label: "Screen the candidate",
      system:
        "You are the scanner seat of an opportunistic DeFi desk. You care about correctness and bounded loss, never about winning a mempool race.",
      prompt:
        "Candidate: {{input}}\n\nIs this worth trading after gas, slippage, and pool depth? Reply with exactly one word: TRADE or PASS.",
      next: "worth-it",
    })
    .branch("worth-it", {
      label: "Worth trading?",
      when: { source: "{{steps.screen.text}}", op: "equals", value: "TRADE" },
      onTrue: "plan",
      onFalse: "pass-note",
    })
    .model("plan", {
      label: "Plan the route",
      system: "You are the route planner. Output a concrete plan, never a strategy essay.",
      prompt:
        "Candidate: {{input}}\n\nWrite the trade plan in five lines: swap path, inventory or flash-loan, chain, max slippage, deadline. Name only venues the desk has already admitted.",
      next: "hand-off",
    })
    .agent("hand-off", {
      label: "Hand the plan to the executor",
      action: "invoke",
      agent: "{{crew.executor}}",
      flowId: "desk-execute-trade",
      prompt: "{{steps.plan.text}}",
      next: "log",
    })
    .model("log", {
      label: "Log the handoff",
      prompt:
        "Executor result: {{steps.hand-off.json}}\nPlan: {{steps.plan.text}}\n\nWrite the one-line desk log entry: what was proposed, and whether it executed, escalated, or was refused.",
      next: null,
    })
    .model("pass-note", {
      label: "Log the pass",
      prompt:
        "The scanner passed on {{input}} because: {{steps.screen.text}}. Write one line for the desk log.",
      next: null,
    })
    .build(),
};

const deskExecuteTrade: FlowTemplate = {
  id: "tpl-desk-execute-trade",
  name: "Desk: execute trade",
  description:
    "Pre-flight a route plan and propose the trade at clip size. Under the executor's cap it executes; over it, the intent sits pending the risk manager onchain and the flow writes the memo they will read.",
  category: "trading",
  author: "LaCrew",
  definition: flow("desk-execute-trade", "Desk: execute trade")
    .describe(
      "Run input is the route plan plus your simulator's result. Runs as the executor. This flow does not simulate — the dry-run belongs to the executor's own tooling, and a model asked to 'simulate' would be inventing a result nobody ran.",
    )
    .source({ templateId: "tpl-desk-execute-trade", author: "LaCrew" })
    .model("preflight", {
      label: "Pre-flight the plan",
      system:
        "You check trade plans for missing guards before they are proposed. You do not simulate; you check that the plan states what it must.",
      prompt:
        "Plan and simulation result: {{input}}\n\nDoes the plan state a max slippage, a deadline, an admitted venue, and a size? Reply with exactly one word and nothing else: SEND or FIX.",
      next: "ready",
    })
    .branch("ready", {
      label: "Cleared pre-flight?",
      when: { source: "{{steps.preflight.text}}", op: "equals", value: "SEND" },
      onTrue: "trade",
      onFalse: "fix-note",
    })
    .gate("trade", {
      label: "Propose the trade at clip size",
      target: "{{target.dex-router}}",
      value: "200000000",
      onAllow: "receipt",
      onEscalate: "risk-memo",
      onDeny: "stand-down",
    })
    .model("receipt", {
      label: "File the receipt",
      prompt:
        "Trade allowed under policy: {{steps.trade.json}}\nPlan: {{input}}\n\nWrite a one-line trade receipt for the audit trail: venue, size, expected PnL, and the simulated gas the plan carried.",
      next: null,
    })
    .model("risk-memo", {
      label: "Memo for the risk manager",
      prompt:
        "The trade escalated and the intent is pending the risk manager's approval onchain: {{steps.trade.json}}\nPlan: {{input}}\n\nWrite the two-sentence memo the risk manager reads before approving or denying. Lead with the loss if the route is wrong.",
      next: null,
    })
    .model("stand-down", {
      label: "Stand down",
      prompt:
        "Policy denied the trade: {{steps.trade.json}}. Write one line naming which limit refused it — an unadmitted venue, or a size past the cap — and what would have to change.",
      next: null,
    })
    .model("fix-note", {
      label: "Send the plan back",
      prompt:
        "Pre-flight refused this plan: {{input}}\n\nWrite one line telling the planner exactly which guard is missing: slippage, deadline, venue, or size.",
      next: null,
    })
    .build(),
};

const deskKillSwitch: FlowTemplate = {
  id: "tpl-desk-kill-switch",
  name: "Desk: risk kill switch",
  description:
    "Every epoch, judge the desk's loss streak and either halt the executor, cut its clip size, or let it run. Deactivation is reversible; firing is not, so this never fires anyone.",
  category: "trading",
  author: "LaCrew",
  definition: flow("desk-kill-switch", "Desk: risk kill switch")
    .describe(
      "Run input is the epoch PnL digest. An unreadable assessment halts rather than continues — a kill switch that fails open is not a kill switch.",
    )
    .trigger("epoch")
    .source({ templateId: "tpl-desk-kill-switch", author: "LaCrew" })
    .tool("pending", "lacrew_list_pending_intents", undefined, {
      label: "List pending escalations",
      next: "org",
    })
    .tool("org", "lacrew_get_org_tree", undefined, {
      label: "Read the desk",
      next: "assess",
    })
    .model("assess", {
      label: "Assess the drawdown",
      system:
        "You are the risk manager of a DeFi desk. You are paid to stop losses, not to defend strategies.",
      prompt:
        "Epoch PnL digest: {{input}}\nDesk: {{steps.org.json}}\nPending escalations: {{steps.pending.json}}\n\nReply with exactly one word: HALT (drawdown past the kill threshold), TIGHTEN (bleeding but recoverable), or CONTINUE.",
      next: "route",
    })
    .switch("route", {
      label: "HALT / TIGHTEN / CONTINUE",
      when: { source: "{{steps.assess.text}}" },
      cases: [
        { value: "HALT", next: "halt" },
        { value: "TIGHTEN", next: "tighten" },
        { value: "CONTINUE", next: "log" },
      ],
      onDefault: "halt",
    })
    .org("halt", {
      label: "Deactivate the executor",
      action: "deactivate",
      node: "{{crew.executor}}",
      onAllow: "notify",
      onEscalate: "notify",
      onDeny: "log",
    })
    .org("tighten", {
      label: "Cut the clip size to 50 USDC",
      action: "set-cap",
      node: "{{crew.executor}}",
      cap: "50000000",
      onAllow: "notify",
      onEscalate: "notify",
      onDeny: "log",
    })
    .model("notify", {
      label: "Ping the human root",
      prompt:
        "The desk was throttled: {{steps.assess.text}}. Outcome: halt={{steps.halt.json}} tighten={{steps.tighten.json}}\n\nWrite the alert the human root reads on their phone: what changed, whether it is already in force or waiting on a proposal, and what re-enables the desk.",
      next: null,
    })
    .model("log", {
      label: "Log the epoch",
      prompt:
        "Assessment: {{steps.assess.text}}. Digest: {{input}}\n\nWrite the one-line epoch entry for the desk log.",
      next: null,
    })
    .build(),
};

const deskVenueOnboarding: FlowTemplate = {
  id: "tpl-desk-venue-onboarding",
  name: "Desk: venue onboarding",
  description:
    "Diligence a new router or pool and, if it clears, whitelist it for the executor. A new venue is constitutional, so the write lands as a governance proposal rather than a silent policy change.",
  category: "trading",
  author: "LaCrew",
  definition: flow("desk-venue-onboarding", "Desk: venue onboarding")
    .describe("Run input is the router or pool address the desk wants to add.")
    .source({ templateId: "tpl-desk-venue-onboarding", author: "LaCrew" })
    .model("diligence", {
      label: "Diligence the venue",
      system:
        "You review trading venues before a desk is allowed to touch them. You are looking for reasons to say no.",
      prompt:
        "Candidate venue: {{input}}\n\nWork through factory provenance, pool depth, fee mechanics, oracle dependencies, and upgradeability. State what you found for each.",
      next: "verdict",
    })
    .model("verdict", {
      label: "Admit or refuse",
      prompt:
        "Diligence findings: {{steps.diligence.text}}\n\nReply with exactly one word and nothing else: ADMIT or REFUSE.",
      next: "clear",
    })
    .branch("clear", {
      label: "Cleared diligence?",
      when: { source: "{{steps.verdict.text}}", op: "equals", value: "ADMIT" },
      onTrue: "whitelist",
      onFalse: "refuse-note",
    })
    .org("whitelist", {
      label: "Whitelist the venue for the executor",
      action: "set-whitelist",
      node: "{{crew.executor}}",
      target: "{{input}}",
      allowed: true,
      onAllow: "admit-note",
      onEscalate: "admit-note",
      onDeny: "refuse-note",
    })
    .model("admit-note", {
      label: "Brief the voters",
      prompt:
        "Whitelisting {{input}} came back {{steps.whitelist.verdict}}: {{steps.whitelist.json}}\nDiligence: {{steps.diligence.text}}\n\nWrite the note the human root reads before voting: what the venue is, the one risk that would make you vote no, and what is still unwhitelisted after this lands.",
      next: null,
    })
    .model("refuse-note", {
      label: "Record the refusal",
      prompt:
        "The venue {{input}} was not admitted. Diligence: {{steps.diligence.text}}\n\nWrite one line for the desk log naming the disqualifying finding.",
      next: null,
    })
    .build(),
};

/* ------------------------------------------------------------------ *
 * GitHub experts (design-partners/02-github-experts-manager.md)
 * ------------------------------------------------------------------ */

const botPrTriage: FlowTemplate = {
  id: "tpl-bot-pr-triage",
  name: "Bot PR triage",
  description:
    "Read one dependency-bot PR from GitHub, classify it, and either merge it, reserve the budget for a fix, or hand it to a human. The merge is asked of policy first and refused by the connector independently — admitting or revoking one address turns the crew's merge authority on or off org-wide.",
  category: "dev",
  author: "LaCrew",
  definition: flow("bot-pr-triage", "Bot PR triage")
    .describe(
      'Run input is JSON: {"owner":"…","repo":"…","number":7}. The PR is fetched through the `github` connector rather than pasted in, so the crew reads what is actually there. Merging asks `lacrew_check_policy` about the merge-authority address and routes on the verdict; the connector re-checks it before the call, so a flow that skipped the question still cannot merge.',
    )
    .source({ templateId: "tpl-bot-pr-triage", author: "LaCrew" })
    .tool(
      "pr",
      "github.get_pull_request",
      { owner: "{{input.owner}}", repo: "{{input.repo}}", number: "{{input.number}}" },
      { label: "Fetch the pull request", next: "classify" },
    )
    .model("classify", {
      label: "Classify the PR",
      system:
        "You triage dependency-bot pull requests. Patch and minor bumps with green CI are routine; majors, workflow-file edits, and unknown authors are not.",
      prompt:
        "Pull request: {{steps.pr.json}}\n\nReply with exactly one word and nothing else: MERGE (safe, CI green, allowed labels), FIX (would merge but something is broken), HOLD (needs a human), or REJECT (author is not a known bot, or the diff touches CI workflows or secrets).",
      next: "route",
    })
    .switch("route", {
      label: "Route the verdict",
      when: { source: "{{steps.classify.text}}" },
      cases: [
        { value: "MERGE", next: "merge-check" },
        { value: "FIX", next: "fix-budget" },
        { value: "HOLD", next: "hold-note" },
        { value: "REJECT", next: "reject-note" },
      ],
      onDefault: "hold-note",
    })
    .tool(
      "merge-check",
      "lacrew_check_policy",
      { target: "{{target.merge-authority}}", value: "0" },
      { label: "May this crew merge?", next: "may-merge" },
    )
    .branch("may-merge", {
      label: "Merge authority admitted?",
      when: { source: "{{steps.merge-check.json}}", op: "contains", value: '"ALLOW"' },
      onTrue: "merge",
      onFalse: "merge-blocked",
    })
    .tool(
      "merge",
      "github.merge_pull_request",
      {
        owner: "{{input.owner}}",
        repo: "{{input.repo}}",
        number: "{{input.number}}",
        merge_method: "squash",
      },
      { label: "Merge the PR", next: "merge-note" },
    )
    .model("merge-note", {
      label: "Record the merge",
      prompt:
        "Merge result: {{steps.merge.json}}\nPR: {{steps.pr.json}}\n\nWrite the one-line record for the weekly digest: repo, dependency, version jump, and the check that justified merging. If the call did not return success, say that plainly and do not describe it as merged.",
      next: null,
    })
    .model("merge-blocked", {
      label: "Merge authority refused",
      prompt:
        "Policy answered {{steps.merge-check.json}} for the merge-authority address, so nothing was merged.\nPR: {{steps.pr.json}}\n\nWrite one line for the maintainer: which PR is waiting, and that admitting the merge-authority address is a governance change, not a retry.",
      next: null,
    })
    .gate("fix-budget", {
      label: "Reserve the triage budget",
      target: "{{target.model-api}}",
      value: "10000000",
      onAllow: "delegate-fix",
      onEscalate: "budget-note",
      onDeny: "budget-note",
    })
    .agent("delegate-fix", {
      label: "Hand the PR to the fixer",
      action: "invoke",
      agent: "{{crew.fixer}}",
      flowId: "dep-fix-loop",
      prompt: "{{steps.pr.json}}",
      next: "fix-note",
    })
    .model("fix-note", {
      label: "Report the fix attempt",
      prompt:
        "Fixer result: {{steps.delegate-fix.json}}\nPR: {{steps.pr.json}}\n\nWrite the PR comment: what was changed, why, and what a reviewer should check before the merge.",
      next: null,
    })
    .model("hold-note", {
      label: "Escalate to a human",
      prompt:
        "PR: {{steps.pr.json}}\nTriage: {{steps.classify.text}}\n\nWrite the two-line note for the maintainer's queue: what makes this a human decision, and the smallest thing that would unblock it.",
      next: null,
    })
    .model("reject-note", {
      label: "Record the refusal",
      prompt:
        "PR: {{steps.pr.json}}\n\nThis PR was refused. Write one line naming the disqualifier — unknown author, workflow-file edit, or a path the crew may not touch — and say plainly that nothing was merged.",
      next: null,
    })
    .model("budget-note", {
      label: "Ask for fix budget",
      prompt:
        "The fix budget did not clear policy: {{steps.fix-budget.json}}\nPR: {{steps.pr.json}}\n\nWrite the two-sentence request the review lead reads: what the repair costs, what it unblocks, and what happens if it waits.",
      next: null,
    })
    .build(),
};

const depFixLoop: FlowTemplate = {
  id: "tpl-dep-fix-loop",
  name: "Dependency fix loop",
  description:
    "Diagnose a red dependency PR, and either re-run a flake, spend the patch budget on a small fix, or hand a large or security-sensitive change to a human. The loop cannot run itself past its allowance.",
  category: "dev",
  author: "LaCrew",
  definition: flow("dep-fix-loop", "Dependency fix loop")
    .describe(
      "Run input is the failing PR plus the CI log excerpt. There is no retry edge on purpose: a fix-until-green loop is exactly the runaway the budget is meant to stop, so each attempt is one run against one gate.",
    )
    .source({ templateId: "tpl-dep-fix-loop", author: "LaCrew" })
    .model("diagnose", {
      label: "Diagnose the failure",
      system: "You debug CI failures on dependency-bump PRs. Be specific about the cause.",
      prompt:
        "Failing PR and CI excerpt: {{input}}\n\nReply with exactly one word: FLAKE (infrastructure or timing, unrelated to the bump), SMALL (a contained code or config change), LARGE (a breaking-change migration), or SECURITY (touches auth, crypto, CI workflows, or secrets).",
      next: "route",
    })
    .switch("route", {
      label: "Route the diagnosis",
      when: { source: "{{steps.diagnose.text}}" },
      cases: [
        { value: "FLAKE", next: "rerun" },
        { value: "SMALL", next: "patch-budget" },
        { value: "LARGE", next: "handoff" },
        { value: "SECURITY", next: "handoff" },
      ],
      onDefault: "handoff",
    })
    .model("rerun", {
      label: "Re-run the job",
      prompt:
        "The failure reads as infrastructure, not the bump: {{input}}\n\nWrite the one-line re-run request naming the job and the evidence it was a flake.",
      next: null,
    })
    .gate("patch-budget", {
      label: "Spend the patch budget",
      target: "{{target.ci-minutes}}",
      value: "25000000",
      onAllow: "patch",
      onEscalate: "handoff",
      onDeny: "handoff",
    })
    .model("patch", {
      label: "Write the patch",
      prompt:
        "Budget cleared: {{steps.patch-budget.json}}\nFailure: {{input}}\nDiagnosis: {{steps.diagnose.text}}\n\nWrite the minimal patch: the files to change, the change in each, and the commit message. Touch nothing beyond what the failure requires.",
      next: null,
    })
    .model("handoff", {
      label: "Hand to a human",
      prompt:
        "Failure: {{input}}\nDiagnosis: {{steps.diagnose.text}}\n\nWrite the handoff note: why this is not an automated fix, what you would try first, and the blast radius if it goes wrong.",
      next: null,
    })
    .build(),
};

const mergeWindowDigest: FlowTemplate = {
  id: "tpl-merge-window-digest",
  name: "Merge window digest",
  description:
    "Weekly: what the crew merged, what is stuck and why, and how much of the crew's allowance the repair work consumed.",
  category: "dev",
  author: "LaCrew",
  definition: flow("merge-window-digest", "Merge window digest")
    .describe("Run input is the week's merge log. Fires Monday 09:00 UTC.")
    .trigger("cron")
    .schedule("0 9 * * 1")
    .source({ templateId: "tpl-merge-window-digest", author: "LaCrew" })
    .tool("org", "lacrew_get_org_tree", undefined, {
      label: "Read the crew",
      next: "pending",
    })
    .tool("pending", "lacrew_list_pending_intents", undefined, {
      label: "List pending escalations",
      next: "digest",
    })
    .model("digest", {
      label: "Write the digest",
      system: "You write the weekly digest a maintainer reads in ninety seconds.",
      prompt:
        "Merge log: {{input}}\nCrew: {{steps.org.json}}\nPending escalations: {{steps.pending.json}}\n\nWrite four short sections: merged (counts by repo), blocked and why, spend against allowance, and the decisions waiting on a human. Name anything that has been pending more than a week.",
      next: null,
    })
    .build(),
};

/* ------------------------------------------------------------------ *
 * Content studio (design-partners/03-marketing-content-crew.md)
 * ------------------------------------------------------------------ */

const contentWeeklyBrief: FlowTemplate = {
  id: "tpl-content-weekly-brief",
  name: "Content: weekly article pipeline",
  description:
    "Ideate, put the shortlist to a vote among the specialist seats, draft in the account's voice, review, build the image pack, then ask policy whether publishing is allowed — it is not, by design, so the run ends in a human sign-off package.",
  category: "content",
  author: "LaCrew",
  definition: flow("content-weekly-brief", "Content: weekly article pipeline")
    .describe(
      "Run input is the account brief: which account (personal or org), its voice, and this week's themes. Run it once per account — the whole point is that the two brands never share a draft. Publication is asked of policy before it is attempted: an unadmitted endpoint answers DENY and the flow assembles the sign-off package. Proposing against it instead would revert at the session key, and a reverted run writes no package at all.",
    )
    .trigger("cron")
    .schedule("0 8 * * 1")
    .source({ templateId: "tpl-content-weekly-brief", author: "LaCrew" })
    .model("ideate", {
      label: "Generate the shortlist",
      system:
        "You are the ideation lead of a content studio. You write for one account at a time and never recycle another brand's angle.",
      prompt:
        "Account brief: {{input}}\n\nPropose six article ideas for this account only. One line each: working title, the reader it is for, and why it is worth writing this week.",
      next: "vote-domain",
    })
    .agent("vote-domain", {
      label: "Domain expert ranks the shortlist",
      action: "invoke",
      agent: "{{crew.domain-expert}}",
      prompt:
        "Rank these ideas by how well we can defend them factually, and name any claim we cannot source:\n\n{{steps.ideate.text}}",
      next: "vote-growth",
    })
    .agent("vote-growth", {
      label: "Growth seat ranks the shortlist",
      action: "invoke",
      agent: "{{crew.growth-seo}}",
      prompt:
        "Rank these ideas by discoverability and hook strength, without keyword stuffing. Say which title you would change and to what:\n\n{{steps.ideate.text}}",
      next: "tally",
    })
    .model("tally", {
      label: "Tally the vote",
      prompt:
        "Shortlist: {{steps.ideate.text}}\nDomain ranking: {{steps.vote-domain.json}}\nGrowth ranking: {{steps.vote-growth.json}}\n\nPick the winner and say in two lines why it beat the runner-up. If the two rankings disagree at the top, say so and pick the one with the defensible claims.",
      next: "draft",
    })
    .agent("draft", {
      label: "Staff writer drafts the article",
      action: "invoke",
      agent: "{{crew.staff-writer}}",
      prompt:
        "Write the full article in the voice described in this brief: {{input}}\n\nWinning idea: {{steps.tally.text}}\n\nMedium-ready structure: title, subtitle, headings, one pull quote, and image slots marked in place.",
      next: "voice-review",
    })
    .agent("voice-review", {
      label: "Editor reviews voice and clarity",
      action: "invoke",
      agent: "{{crew.editor-voice}}",
      prompt:
        "Edit for voice, clarity, and consistency with this account's previous posts. Return the changelog of what you changed and why:\n\n{{steps.draft.json}}",
      next: "image-budget",
    })
    .gate("image-budget", {
      label: "Reserve the image budget",
      target: "{{target.image-api}}",
      value: "20000000",
      onAllow: "image-pack",
      onEscalate: "image-pack",
      onDeny: "image-pack",
    })
    .model("image-pack", {
      label: "Build the image pack",
      prompt:
        "Article: {{steps.draft.json}}\nImage budget verdict: {{steps.image-budget.verdict}}\n\nProduce the image pack: for the hero and each in-body slot, a generation prompt, alt text, a filename, and where it sits in the post. If the budget verdict was not ALLOW, say which images are prompts-only until someone approves the spend.",
      next: "publish-check",
    })
    .tool(
      "publish-check",
      "lacrew_check_policy",
      { target: "{{target.publish-endpoint}}", value: "1000000" },
      { label: "Ask policy whether publishing is allowed", next: "publish-allowed" },
    )
    .branch("publish-allowed", {
      label: "Is the publishing endpoint admitted?",
      when: { source: "{{steps.publish-check.json}}", op: "contains", value: "\"ALLOW\"" },
      onTrue: "publish",
      onFalse: "signoff",
    })
    .gate("publish", {
      label: "Pay the publication fee",
      target: "{{target.publish-endpoint}}",
      value: "1000000",
      onAllow: "published",
      onEscalate: "signoff",
      onDeny: "signoff",
    })
    .model("signoff", {
      label: "Package for human sign-off",
      prompt:
        "Publication was not authorised — policy answered {{steps.publish-check.json}}\nArticle: {{steps.draft.json}}\nEditor changelog: {{steps.voice-review.json}}\nImage pack: {{steps.image-pack.text}}\n\nAssemble the sign-off package: title and subtitle, where the body and image pack live, what each reviewer changed, and publish status — which is `draft`. State plainly that nothing was published.",
      next: null,
    })
    .model("published", {
      label: "Record the publication",
      prompt:
        "Publication cleared policy: {{steps.publish.json}}\n\nWrite the audit line: which account, which article, and which policy allowed it. Anyone reading this should be able to tell whether a human or a policy change opened the gate.",
      next: null,
    })
    .build(),
};

const contentDailySocial: FlowTemplate = {
  id: "tpl-content-daily-social",
  name: "Content: daily social drafts",
  description:
    "Daily per-account social drafts, brand-checked before they reach the queue. Queueing is a spend; publishing is not this flow's to do.",
  category: "content",
  author: "LaCrew",
  definition: flow("content-daily-social", "Content: daily social drafts")
    .describe(
      "Run input is the account brief and this week's themes. Run once per account: the same copy on a personal and an org account is one of the failures this crew exists to avoid. Fires 13:00 UTC.",
    )
    .trigger("cron")
    .schedule("0 13 * * *")
    .source({ templateId: "tpl-content-daily-social", author: "LaCrew" })
    .model("drafts", {
      label: "Draft today's posts",
      system:
        "You are the social desk. You write for exactly one account and match its voice, not the studio's house style.",
      prompt:
        "Account brief and weekly themes: {{input}}\n\nWrite five posts for this account: distinct angles, no thread-of-the-same-idea, no engagement bait, no @-mentions of people who have not been mentioned before.",
      next: "brand-check",
    })
    .model("brand-check", {
      label: "Brand-safety check",
      system:
        "You are the brand-safety reviewer. Fabricated statistics, invented quotes, unreleased product details, and competitor claims are all failures.",
      prompt:
        "Posts: {{steps.drafts.text}}\n\nReply with exactly one word: CLEAR or REWRITE.",
      next: "clear",
    })
    .branch("clear", {
      label: "Cleared?",
      when: { source: "{{steps.brand-check.text}}", op: "equals", value: "CLEAR" },
      onTrue: "queue",
      onFalse: "rewrite",
    })
    .model("rewrite", {
      label: "Rewrite the flagged posts",
      prompt:
        "Posts: {{steps.drafts.text}}\n\nRewrite so every claim is sourced or softened to an opinion, and drop any post that cannot be saved. Say which you dropped.",
      next: "queue",
    })
    .gate("queue", {
      label: "Queue the drafts",
      target: "{{target.scheduler}}",
      value: "5000000",
      onAllow: "queued",
      onEscalate: "hold",
      onDeny: "hold",
    })
    .model("queued", {
      label: "Confirm the queue",
      prompt:
        "Queued under policy: {{steps.queue.json}}\n\nWrite the one-line entry for the daily glance: account, how many drafts are waiting, and that they are drafts.",
      next: null,
    })
    .model("hold", {
      label: "Hold the drafts",
      prompt:
        "Queueing did not clear policy: {{steps.queue.json}}\n\nWrite one line: the drafts exist and are unqueued, which limit refused, and who can clear it.",
      next: null,
    })
    .build(),
};

/** Templates that make up the three first-party crew blueprints. */
export const crewFlowTemplates: FlowTemplate[] = [
  deskOpportunityScan,
  deskExecuteTrade,
  deskKillSwitch,
  deskVenueOnboarding,
  botPrTriage,
  depFixLoop,
  mergeWindowDigest,
  contentWeeklyBrief,
  contentDailySocial,
];
