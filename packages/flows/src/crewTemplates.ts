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
    "Read one dependency-bot PR from GitHub, classify it, and either merge it, reserve the budget for a fix, or hand it to a human. The fix path posts its note back on the PR. Both writes are asked of policy first and refused by the connector independently, against separate addresses — merge authority and comment authority are revoked one without the other.",
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
        "Fixer result: {{steps.delegate-fix.json}}\nPR: {{steps.pr.json}}\n\nWrite the PR comment: what was changed, why, and what a reviewer should check before the merge. Write only the comment body — it is posted verbatim.",
      next: "comment-check",
    })
    .tool(
      "comment-check",
      "lacrew_check_policy",
      { target: "{{target.comment-authority}}", value: "0" },
      { label: "May this crew comment?", next: "may-comment" },
    )
    .branch("may-comment", {
      label: "Comment authority admitted?",
      when: { source: "{{steps.comment-check.json}}", op: "contains", value: '"ALLOW"' },
      onTrue: "post-fix-note",
      onFalse: "comment-blocked",
    })
    .tool(
      "post-fix-note",
      "github.create_issue_comment",
      {
        owner: "{{input.owner}}",
        repo: "{{input.repo}}",
        number: "{{input.number}}",
        body: "{{steps.fix-note.text}}",
      },
      { label: "Post the note on the PR", next: null },
    )
    .model("comment-blocked", {
      label: "Comment authority refused",
      prompt:
        "Policy answered {{steps.comment-check.json}} for the comment-authority address, so the note was written but not posted.\nNote: {{steps.fix-note.text}}\n\nWrite one line for the maintainer's queue: which PR the note belongs on, and that admitting the comment-authority address is a governance change, not a retry.",
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
    "Diagnose a red dependency PR, and either re-run a flake, spend the patch budget on a small fix and push it to the PR branch as one commit, or hand a large or security-sensitive change to a human. The push is asked of policy first and refused by the connector independently, against the crew's own push-authority address. The loop cannot run itself past its allowance.",
  category: "dev",
  author: "LaCrew",
  definition: flow("dep-fix-loop", "Dependency fix loop")
    .describe(
      'Run input is JSON: {"owner":"…","repo":"…","number":7,"branch":"dependabot/…","path":"src/index.ts","log":"…"} — the PR, the branch the fix lands on, the file that is failing, and the CI excerpt. There is no retry edge on purpose: a fix-until-green loop is exactly the runaway the budget is meant to stop, so each attempt is one run against one gate. The push asks `lacrew_check_policy` about the push-authority address and stops on anything but ALLOW without touching GitHub; the connector re-checks it, and only writes to a branch the operator allowlisted at registration. It lands through git\'s own object API — tree, commit, ref — so a fix that touches several files is one commit, one CI run, and one diff to read.',
    )
    .source({ templateId: "tpl-dep-fix-loop", author: "LaCrew" })
    .model("diagnose", {
      label: "Diagnose the failure",
      system: "You debug CI failures on dependency-bump PRs. Be specific about the cause.",
      prompt:
        "Failing PR and CI excerpt: {{input}}\n\nReply with exactly one word: FLAKE (infrastructure or timing, unrelated to the bump), SMALL (a contained code or config change), LARGE (a breaking-change migration), or SECURITY (touches auth, crypto, CI workflows, or secrets).",
      next: "route",
    })
    // The order matters. Asking before reading means a crew whose push
    // authority was never admitted spends nothing and touches GitHub not at
    // all — the refusal is the first thing that happens, not the last.
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
      onAllow: "push-check",
      onEscalate: "handoff",
      onDeny: "handoff",
    })
    .tool(
      "push-check",
      "lacrew_check_policy",
      { target: "{{target.push-authority}}", value: "0" },
      { label: "May this crew push?", next: "may-push" },
    )
    .branch("may-push", {
      label: "Push authority admitted?",
      when: { source: "{{steps.push-check.json}}", op: "contains", value: '"ALLOW"' },
      onTrue: "read-changed",
      onFalse: "push-blocked",
    })
    .tool(
      "read-changed",
      "github.list_pull_request_files",
      { owner: "{{input.owner}}", repo: "{{input.repo}}", number: "{{input.number}}" },
      { label: "Read what the bump changed", next: "read-source" },
    )
    .tool(
      "read-source",
      "github.get_file_raw",
      {
        owner: "{{input.owner}}",
        repo: "{{input.repo}}",
        path: "{{input.path}}",
        ref: "{{input.branch}}",
      },
      { label: "Read the failing file", next: "patch" },
    )
    .model("patch", {
      label: "Write the patch",
      system:
        "You repair a CI failure on a dependency-bump branch. Reply with a JSON array and nothing else: [{\"path\":\"src/index.ts\",\"content\":\"<the complete new file>\"}]. Each entry replaces that file in full, so only include a file whose current contents you were given, and change nothing the failure does not require. No fences, no commentary.",
      prompt:
        "Budget cleared: {{steps.patch-budget.json}}\nFailure: {{input}}\nDiagnosis: {{steps.diagnose.text}}\nWhat the bump changed: {{steps.read-changed.json.body}}\nCurrent {{input.path}} on {{input.branch}}: {{steps.read-source.json.body}}\n\nReply with the JSON array of files to write.",
      next: "read-head",
    })
    // The git dance, spelled out: where the branch is, what it points at, a new
    // tree, a commit, and then — and only then — the branch moves. Every file
    // lands in one commit, so CI runs once and a reviewer reads one diff.
    .tool(
      "read-head",
      "github.get_ref",
      { owner: "{{input.owner}}", repo: "{{input.repo}}", branch: "{{input.branch}}" },
      { label: "Where the branch points", next: "read-base" },
    )
    .tool(
      "read-base",
      "github.get_commit",
      {
        owner: "{{input.owner}}",
        repo: "{{input.repo}}",
        sha: "{{steps.read-head.json.body.object.sha}}",
      },
      { label: "The tree it points at", next: "build-tree" },
    )
    .tool(
      "build-tree",
      "github.create_tree",
      {
        owner: "{{input.owner}}",
        repo: "{{input.repo}}",
        // Based on the branch's own tree, so every file the fix does not name
        // stays exactly as it was.
        base_tree: "{{steps.read-base.json.body.tree.sha}}",
        tree: "{{steps.patch.text}}",
      },
      { label: "Build the tree", next: "build-commit" },
    )
    .tool(
      "build-commit",
      "github.create_commit",
      {
        owner: "{{input.owner}}",
        repo: "{{input.repo}}",
        message: "fix: repair CI on the dependency bump",
        tree: "{{steps.build-tree.json.body.sha}}",
        // The head the run read, not one a model retyped. If the branch moved
        // underneath, the update below is a non-fast-forward and GitHub refuses
        // it — the fix is lost, which is the right way to lose it.
        parents: "{{steps.read-head.json.body.object.sha}}",
      },
      { label: "Commit the tree", next: "push" },
    )
    .tool(
      "push",
      "github.update_ref",
      {
        owner: "{{input.owner}}",
        repo: "{{input.repo}}",
        branch: "{{input.branch}}",
        sha: "{{steps.build-commit.json.body.sha}}",
      },
      { label: "Move the branch to the fix", next: "push-note" },
    )
    .model("push-note", {
      label: "Record the push",
      prompt:
        "Push result: {{steps.push.json}}\nFiles written: {{steps.patch.text}}\nDiagnosis: {{steps.diagnose.text}}\n\nWrite the one-line record for the review lead: what was changed, on which branch, and what CI has to say before this can merge. If the call did not return success, say that plainly and do not describe the fix as pushed.",
      next: null,
    })
    .model("push-blocked", {
      label: "Push authority refused",
      prompt:
        "Policy answered {{steps.push-check.json}} for the push-authority address, so nothing was written and nothing was read.\nFailure: {{input}}\nDiagnosis: {{steps.diagnose.text}}\n\nWrite the two-line note for the review lead: what the fix would have been, and that admitting the push-authority address is a governance change, not a retry.",
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
      when: { source: "{{steps.publish-check.json}}", op: "contains", value: '"ALLOW"' },
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
      prompt: "Posts: {{steps.drafts.text}}\n\nReply with exactly one word: CLEAR or REWRITE.",
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

/* ------------------------------------------------------------------ *
 * LP position advisor (author-drafted pattern)
 *
 * The only pipeline here that asks policy a question it expects to be
 * refused. The crew advises on positions it does not own, and no venue is
 * admitted to it, so the refusal is what turns an analysis into a memo a
 * human executes. An ALLOW would mean somebody admitted a router to an
 * advisory crew, which is drift worth naming rather than acting on.
 * ------------------------------------------------------------------ */

const lpRangeReview: FlowTemplate = {
  id: "tpl-lp-range-review",
  name: "LP: range and fee review",
  description:
    "Resolve a watched wallet's LP positions, judge each against its range and accrued fees, and write the rebalance memo. The crew never places the trade — its policy stack has nowhere to place it.",
  category: "trading",
  author: "LaCrew",
  definition: flow("lp-range-review", "LP: range and fee review")
    .describe(
      'Run input is JSON: {"owner":"0x…","subgraph_id":"…"} — the wallet to read and the Uniswap v3 deployment to read it from. Runs as the position mapper. Note the GraphQL filter is written with spaces inside its braces: an adjacent "{{" would be read as an interpolation placeholder and eaten before the query was ever sent.',
    )
    .trigger("cron")
    .schedule("0 7 * * *")
    .source({ templateId: "tpl-lp-range-review", author: "LaCrew" })
    .tool(
      "positions",
      "uniswap.query",
      {
        subgraph_id: "{{input.subgraph_id}}",
        query:
          '{ positions(where: { owner: "{{input.owner}}" }) { id liquidity tickLower tickUpper depositedToken0 depositedToken1 collectedFeesToken0 collectedFeesToken1 pool { id feeTier tick totalValueLockedUSD } } }',
      },
      { label: "Resolve the wallet's positions", next: "assess" },
    )
    .model("assess", {
      label: "Judge the positions",
      system:
        "You review liquidity positions for a crew that advises and never trades. You are describing what is true of a position, not arguing for a trade.",
      prompt:
        "Positions: {{steps.positions.json}}\n\nFor each position, work out whether the current tick sits inside its range, how the fees collected compare to the divergence loss against simply holding, and whether the pool's depth has moved enough to matter. Then reply with exactly one word for the wallet as a whole: REBALANCE, HOLD, or EXIT.",
      next: "route",
    })
    .switch("route", {
      label: "REBALANCE / HOLD / EXIT",
      when: { source: "{{steps.assess.text}}" },
      cases: [
        { value: "REBALANCE", next: "rebalance-plan" },
        { value: "HOLD", next: "hold-note" },
        { value: "EXIT", next: "exit-memo" },
      ],
      onDefault: "hold-note",
    })
    .model("rebalance-plan", {
      label: "Plan the new range",
      prompt:
        "Positions: {{steps.positions.json}}\nAssessment: {{steps.assess.text}}\n\nWrite the concrete rebalance: which position, the new lower and upper tick, the size to move, and what it costs in gas and forgone fees to move it. State the price move that would make this the wrong call.",
      next: "lead-review",
    })
    .agent("lead-review", {
      label: "Have the advisory lead check the plan",
      action: "invoke",
      agent: "{{crew.advisory-lead}}",
      prompt:
        "Review this rebalance before it goes to a human: {{steps.rebalance-plan.text}}\n\nSay what you would change, or that it stands.",
      next: "execution-check",
    })
    .tool(
      "execution-check",
      "lacrew_check_policy",
      { target: "{{target.dex-router}}", value: "0" },
      { label: "Confirm the desk still cannot execute", next: "may-execute" },
    )
    .branch("may-execute", {
      label: "Was a router admitted?",
      when: { source: "{{steps.execution-check.json}}", op: "contains", value: "ALLOW" },
      onTrue: "drift-alert",
      onFalse: "handoff",
    })
    .model("drift-alert", {
      label: "Flag the drift",
      prompt:
        "Policy answered ALLOW for a router on a crew that is only supposed to advise: {{steps.execution-check.json}}\n\nWrite the alert for the human root. This crew's whole guarantee is that it has nowhere to trade, and something admitted a venue to it. Name what to revoke.",
      next: null,
    })
    .model("handoff", {
      label: "Write the memo",
      prompt:
        "Plan: {{steps.rebalance-plan.text}}\nLead's review: {{steps.lead-review.json}}\nPolicy refused execution, as designed: {{steps.execution-check.json}}\n\nWrite the memo the wallet's owner acts on: the position, the new range, the size, and the one thing that would make this wrong. Say plainly that this is advice and that nothing has been placed.",
      next: null,
    })
    .model("hold-note", {
      label: "Log the hold",
      prompt:
        "Assessment: {{steps.assess.text}}\nPositions: {{steps.positions.json}}\n\nWrite the one-line entry: which positions are in range, and what would have to move for that to change.",
      next: null,
    })
    .model("exit-memo", {
      label: "Write the exit memo",
      prompt:
        "Assessment: {{steps.assess.text}}\nPositions: {{steps.positions.json}}\n\nWrite the memo arguing the position should be closed: why the fees no longer pay for the exposure, and what closing it costs. This is advice; the owner closes it.",
      next: null,
    })
    .build(),
};

/* ------------------------------------------------------------------ *
 * Stablecoin yield desk (author-drafted pattern)
 * ------------------------------------------------------------------ */

const yieldRotationCheck: FlowTemplate = {
  id: "tpl-yield-rotation-check",
  name: "Yield: rotation check",
  description:
    "Every epoch, compare the admitted lending markets against where the capital already sits and rotate only when the spread pays for the move. The allocation is a gate, so a size past the clip waits for the treasury lead onchain.",
  category: "treasury",
  author: "LaCrew",
  definition: flow("yield-rotation-check", "Yield: rotation check")
    .describe(
      'Run input is the desk\'s current allocation and its cash floor, plus {"protocol":"…"} naming the protocol to check TVL on. Runs as the rate scout. The reserve query is written with spaces inside its braces so no adjacent "{{" is read as a placeholder.',
    )
    .trigger("epoch")
    .source({ templateId: "tpl-yield-rotation-check", author: "LaCrew" })
    .tool(
      "reserves",
      "aave.query",
      {
        query:
          "query M { markets(request: { chainIds: [1] }) { name address reserves { underlyingToken { symbol } supplyInfo { apy { value } } borrowInfo { apy { value } } } } }",
      },
      { label: "Read the admitted market's reserves", next: "protocol-tvl" },
    )
    .tool(
      "protocol-tvl",
      "defillama.get_protocol_tvl",
      { protocol: "{{input.protocol}}" },
      { label: "Check the protocol is not bleeding", next: "spread" },
    )
    .model("spread", {
      label: "Is the spread worth the move?",
      system:
        "You allocate stablecoins across lending markets. A rate you cannot exit is not a rate. You are paid to be boring.",
      prompt:
        "Current allocation and cash floor: {{input}}\nReserves: {{steps.reserves.json}}\nProtocol TVL: {{steps.protocol-tvl.json}}\n\nDoes the best admitted market beat where the capital already sits, after gas and after a haircut for the risk you are taking on — and does the move leave the cash floor intact? Reply with exactly one word: ROTATE, HOLD, or DERISK.",
      next: "route",
    })
    .switch("route", {
      label: "ROTATE / HOLD / DERISK",
      when: { source: "{{steps.spread.text}}" },
      cases: [
        { value: "ROTATE", next: "allocate" },
        { value: "HOLD", next: "hold-note" },
        { value: "DERISK", next: "derisk-memo" },
      ],
      onDefault: "hold-note",
    })
    .gate("allocate", {
      label: "Allocate into the admitted market",
      target: "{{target.aave-market}}",
      value: "250000000",
      onAllow: "moved",
      onEscalate: "lead-memo",
      onDeny: "denied-note",
    })
    .model("moved", {
      label: "File the allocation",
      prompt:
        "Allocation allowed under policy: {{steps.allocate.json}}\nReasoning: {{steps.spread.text}}\n\nWrite the one-line entry: which market, how much, the rate it was moved for, and what the cash floor stands at afterwards.",
      next: null,
    })
    .model("lead-memo", {
      label: "Memo for the treasury lead",
      prompt:
        "The allocation escalated and sits pending the treasury lead onchain: {{steps.allocate.json}}\nReserves: {{steps.reserves.json}}\n\nWrite the two-sentence memo they read before approving. Lead with what happens to the capital if the market's liquidity dries up, not with the rate.",
      next: null,
    })
    .model("denied-note", {
      label: "Record the refusal",
      prompt:
        "Policy denied the allocation: {{steps.allocate.json}}\n\nWrite one line naming which limit refused it — a market nobody admitted, or a size past the allocator's cap — and that admitting a market is a high-tier proposal with a timelock.",
      next: null,
    })
    .model("hold-note", {
      label: "Log the hold",
      prompt:
        "Reasoning: {{steps.spread.text}}\nAllocation: {{input}}\n\nWrite the one-line epoch entry: where the capital sits, what it earns, and the spread that would have moved it.",
      next: null,
    })
    .model("derisk-memo", {
      label: "Write the de-risk memo",
      prompt:
        "Reasoning: {{steps.spread.text}}\nReserves: {{steps.reserves.json}}\nProtocol TVL: {{steps.protocol-tvl.json}}\n\nWrite what should be unwound and why the rate stopped paying for the risk. Name the number that changed your mind.",
      next: null,
    })
    .build(),
};

/* ------------------------------------------------------------------ *
 * Protocol risk watch (author-drafted pattern)
 *
 * The sibling crew's executor arrives as a run input rather than a
 * `{{crew.*}}` placeholder. A seat in another crew is not a role this
 * blueprint has, and binding cannot resolve one it does not own — so the
 * account this sweep may halt is handed to it, which is also the more
 * honest shape: the crew is given the authority, it does not assume it.
 * ------------------------------------------------------------------ */

const riskSweep: FlowTemplate = {
  id: "tpl-risk-sweep",
  name: "Risk: protocol sweep",
  description:
    "Every half hour, read the peg, the protocol's TVL and the chain it sits on, and either halt the seat that trades it or log the all-clear. An unreadable assessment halts — a watch that fails open is not a watch.",
  category: "escalation",
  author: "LaCrew",
  definition: flow("risk-sweep", "Risk: protocol sweep")
    .describe(
      'Run input is JSON: {"ids":"…","protocol":"…","executor":"0x…"} — the coin ids to price, the protocol to read TVL for, and the account to deactivate if this goes bad. The executor is an input because it belongs to another crew, and a blueprint can only bind seats it owns.',
    )
    .trigger("cron")
    .schedule("*/30 * * * *")
    .source({ templateId: "tpl-risk-sweep", author: "LaCrew" })
    .tool(
      "price",
      "coingecko.simple_price",
      { ids: "{{input.ids}}", vs_currencies: "usd" },
      { label: "Read the peg", next: "tvl" },
    )
    .tool(
      "tvl",
      "defillama.get_protocol_tvl",
      { protocol: "{{input.protocol}}" },
      { label: "Read the protocol's TVL", next: "chains" },
    )
    .tool("chains", "defillama.list_chains", undefined, {
      label: "Read the chain totals for context",
      next: "org",
    })
    .tool("org", "lacrew_get_org_tree", undefined, {
      label: "Read the org",
      next: "assess",
    })
    .model("assess", {
      label: "Assess the exposure",
      system:
        "You watch protocols an organisation already has money in. You are paid to notice, early, and to be wrong in the direction of caution.",
      prompt:
        "Peg: {{steps.price.json}}\nProtocol TVL: {{steps.tvl.json}}\nChain totals: {{steps.chains.json}}\nOrg: {{steps.org.json}}\n\nIs the stable holding its peg, is TVL leaving this protocol faster than it is leaving the chain it sits on, and has anything about the protocol's risk parameters changed? Reply with exactly one word: DEPEG, FLIGHT, PARAM, or CLEAR.",
      next: "route",
    })
    .switch("route", {
      label: "DEPEG / FLIGHT / PARAM / CLEAR",
      when: { source: "{{steps.assess.text}}" },
      cases: [
        { value: "DEPEG", next: "halt-sibling" },
        { value: "FLIGHT", next: "halt-sibling" },
        { value: "PARAM", next: "escalate-note" },
        { value: "CLEAR", next: "clear-note" },
      ],
      onDefault: "halt-sibling",
    })
    .org("halt-sibling", {
      label: "Deactivate the seat that trades it",
      action: "deactivate",
      node: "{{input.executor}}",
      onAllow: "notify",
      onEscalate: "notify",
      onDeny: "escalate-note",
    })
    .model("notify", {
      label: "Alert the human root",
      prompt:
        "Assessment: {{steps.assess.text}}\nHalt outcome: {{steps.halt-sibling.json}}\nPeg: {{steps.price.json}}\nTVL: {{steps.tvl.json}}\n\nWrite the alert the human root reads on their phone: what changed, whether the seat is already stopped or the deactivation is only a proposal waiting on a vote, and what re-enables it. If it is waiting on a vote, say so first — the crew keeps trading until somebody votes.",
      next: null,
    })
    .model("escalate-note", {
      label: "Escalate to a human",
      prompt:
        "Assessment: {{steps.assess.text}}\nHalt outcome, if one was attempted: {{steps.halt-sibling.json}}\nTVL: {{steps.tvl.json}}\n\nWrite what changed in the protocol's risk parameters, or which limit refused the deactivation, and name who has to act. Do not imply anything has been stopped.",
      next: null,
    })
    .model("clear-note", {
      label: "Log the all-clear",
      prompt:
        "Peg: {{steps.price.json}}\nTVL: {{steps.tvl.json}}\n\nWrite the one-line sweep entry. Say what was read, so an all-clear on a stale feed is legible as one later.",
      next: null,
    })
    .build(),
};

/* ------------------------------------------------------------------ *
 * Governance delegate desk (author-drafted pattern)
 *
 * The only pipeline here whose onchain action moves no value. Nothing in
 * the policy stack meaningfully constrains a vote — the cap, the whitelist
 * and the allowance all answer ALLOW — so what holds this flow honest is
 * its own routing and a human reading the rationale afterwards. The
 * blueprint's guardrails say exactly that rather than implying otherwise.
 * ------------------------------------------------------------------ */

const governanceVoteCycle: FlowTemplate = {
  id: "tpl-governance-vote-cycle",
  name: "Governance: vote cycle",
  description:
    "Read one proposal, check whether the org has a position it moves, decide against the written mandate, and cast the vote with a published rationale. Anything that moves value to or from this org goes to a human instead.",
  category: "governance",
  author: "LaCrew",
  definition: flow("governance-vote-cycle", "Governance: vote cycle")
    .describe(
      'Run input is the proposal text plus {"proposalId":"…"}, which is the LaCrew governance proposal the vote is cast against. Runs as the proposal scout. This flow does not discover anything: the proposal is handed to it, which is the right shape when a human is already looking at one. `governance-proposal-sweep` is the path that starts from a Snapshot space instead.',
    )
    .trigger("cron")
    .schedule("0 10 * * 2")
    .source({ templateId: "tpl-governance-vote-cycle", author: "LaCrew" })
    .tool("pending", "lacrew_list_pending_intents", undefined, {
      label: "See what is already waiting on a human",
      next: "read",
    })
    .model("read", {
      label: "Read the proposal",
      system:
        "You read governance proposals for an organisation that holds tokens. You describe what a proposal does, not what its author says it does.",
      prompt:
        "Proposal: {{input}}\n\nIn three lines: what this actually changes, who is better off if it passes, and what it costs if it passes and the case for it turns out to be wrong.",
      next: "conflict",
    })
    .agent("conflict", {
      label: "Check the org's own exposure",
      action: "invoke",
      agent: "{{crew.conflict-checker}}",
      prompt:
        "Proposal: {{steps.read.text}}\n\nDoes this organisation hold a position this proposal moves, or would it receive or lose money if it passes? Answer plainly, and say so even if the connection is indirect.",
      next: "mandate",
    })
    .model("mandate", {
      label: "Decide against the mandate",
      prompt:
        "Proposal: {{steps.read.text}}\nOur exposure: {{steps.conflict.json}}\nAlready pending a human: {{steps.pending.json}}\n\nDecide against the written mandate. If the proposal moves value to or from this org, or the mandate does not cover it, the answer is ESCALATE — a desk voting on its own payout is not a judgement call. Reply with exactly one word: FOR, AGAINST, ABSTAIN, or ESCALATE.",
      next: "route",
    })
    .switch("route", {
      label: "FOR / AGAINST / ABSTAIN / ESCALATE",
      when: { source: "{{steps.mandate.text}}" },
      cases: [
        { value: "FOR", next: "rationale-for" },
        { value: "AGAINST", next: "rationale-against" },
        { value: "ABSTAIN", next: "abstain-note" },
        { value: "ESCALATE", next: "human-note" },
      ],
      onDefault: "human-note",
    })
    .model("rationale-for", {
      label: "Write the rationale",
      prompt:
        "Proposal: {{steps.read.text}}\nExposure: {{steps.conflict.json}}\n\nWrite the rationale to publish with a vote in favour. Cite the clause of the mandate it rests on, and state the strongest argument against it.",
      next: "cast-for",
    })
    .governance("cast-for", {
      label: "Vote for",
      action: "vote",
      proposalId: "{{input.proposalId}}",
      support: true,
      next: "record",
    })
    .model("rationale-against", {
      label: "Write the rationale",
      prompt:
        "Proposal: {{steps.read.text}}\nExposure: {{steps.conflict.json}}\n\nWrite the rationale to publish with a vote against. Cite the clause of the mandate it rests on, and state what would change your mind.",
      next: "cast-against",
    })
    .governance("cast-against", {
      label: "Vote against",
      action: "vote",
      proposalId: "{{input.proposalId}}",
      support: false,
      next: "record",
    })
    .model("record", {
      label: "Record the vote",
      prompt:
        "Vote for: {{steps.cast-for.json}}\nVote against: {{steps.cast-against.json}}\nRationale: {{steps.rationale-for.text}}{{steps.rationale-against.text}}\n\nWrite the audit line: which proposal, which way, and the mandate clause it rested on. This line is what a human reviews after the fact, which is the only thing standing between the mandate and a vote outside it.",
      next: null,
    })
    .model("abstain-note", {
      label: "Record the abstention",
      prompt:
        "Proposal: {{steps.read.text}}\nExposure: {{steps.conflict.json}}\n\nWrite why the desk stood aside, and what would have to be true for it to vote next time.",
      next: null,
    })
    .model("human-note", {
      label: "Hand it to a human",
      prompt:
        "Proposal: {{steps.read.text}}\nExposure: {{steps.conflict.json}}\nDecision: {{steps.mandate.text}}\n\nWrite why this one is a human's decision rather than the desk's, and the smallest thing that would settle it. If the org stands to gain or lose money here, lead with that.",
      next: null,
    })
    .build(),
};

/* ------------------------------------------------------------------ *
 * Governance: proposal sweep (author-drafted pattern)
 *
 * The discovery half of the desk. `governance-vote-cycle` reasons about a
 * proposal somebody handed it; this one goes and finds it, which is the
 * difference between a desk that watches a protocol and a desk that waits
 * to be told.
 *
 * It ends in an instruction rather than a vote, and that is the design
 * rather than an unfinished edge. A Snapshot vote is an EIP-712 message
 * signed by the delegate's own key — the crew does not hold it, no
 * connector ships a route to the sequencer, and one that did would be a
 * second authority path beside the policy stack. So the sweep produces the
 * thing a human can act on in one read: which proposal, which choice, and
 * the mandate clause it rests on.
 *
 * One rule holds the whole flow together: no model output ever goes back
 * into a query. The single connector call is parameterised by the run
 * input's space and nothing else, and every step after it reasons over
 * what came back. A flow that let a completion name the next id would be
 * interpolating a model into a GraphQL string.
 * ------------------------------------------------------------------ */

const governanceProposalSweep: FlowTemplate = {
  id: "tpl-governance-proposal-sweep",
  name: "Governance: proposal sweep",
  description:
    "Read a Snapshot space's open proposals, pick the one that needs a decision this cycle, check the org's own exposure, and decide against the written mandate. Ends with the vote instruction a human casts, because casting it is a signature this crew does not hold.",
  category: "governance",
  author: "LaCrew",
  definition: flow("governance-proposal-sweep", "Governance: proposal sweep")
    .describe(
      'Run input is JSON: {"space":"aavedao.eth"} — the Snapshot space to sweep. Runs as the proposal scout. The queue is capped at three proposals in the query itself, because each carries its body and the whole result is read by a model. The GraphQL filter is written with spaces inside its braces: an adjacent "{{" would be read as an interpolation placeholder and eaten before the query was sent.',
    )
    .trigger("cron")
    .schedule("0 9 * * 2")
    .source({ templateId: "tpl-governance-proposal-sweep", author: "LaCrew" })
    .tool(
      "queue",
      "snapshot.query",
      {
        query:
          'query { proposals(first: 3, where: { space_in: ["{{input.space}}"], state: "active" }, orderBy: "created", orderDirection: desc) { id title body choices state start end quorum scores scores_total link author space { id name } } }',
      },
      { label: "Read the space's open proposals", next: "pending" },
    )
    .tool("pending", "lacrew_list_pending_intents", undefined, {
      label: "See what is already waiting on a human",
      next: "read",
    })
    .model("read", {
      label: "Pick the one that needs a decision, and say what it does",
      system:
        "You read governance proposals for an organisation that holds tokens. You describe what a proposal does, not what its author says it does.",
      prompt:
        "Open proposals: {{steps.queue.json}}\nAlready pending a human: {{steps.pending.json}}\n\nPick the single proposal that most needs a decision this cycle — the one closing soonest that nothing is already waiting on. Give its id and its title, then in three lines: what it actually changes, who is better off if it passes, and what it costs if it passes and the case for it turns out to be wrong. If the space has no open proposals, say so and stop describing.",
      next: "conflict",
    })
    .agent("conflict", {
      label: "Check the org's own exposure",
      action: "invoke",
      agent: "{{crew.conflict-checker}}",
      prompt:
        "Proposal: {{steps.read.text}}\n\nDoes this organisation hold a position this proposal moves, or would it receive or lose money if it passes? Answer plainly, and say so even if the connection is indirect.",
      next: "mandate",
    })
    .model("mandate", {
      label: "Decide against the mandate",
      prompt:
        "Proposal: {{steps.read.text}}\nOur exposure: {{steps.conflict.json}}\n\nDecide against the written mandate. If the proposal moves value to or from this org, or the mandate does not cover it, or the queue held nothing to decide, the answer is ESCALATE — a desk voting on its own payout is not a judgement call. Reply with exactly one word: FOR, AGAINST, ABSTAIN, or ESCALATE.",
      next: "route",
    })
    .switch("route", {
      label: "FOR / AGAINST / ABSTAIN / ESCALATE",
      when: { source: "{{steps.mandate.text}}" },
      cases: [
        { value: "FOR", next: "rationale" },
        { value: "AGAINST", next: "rationale" },
        { value: "ABSTAIN", next: "abstain-note" },
        { value: "ESCALATE", next: "human-note" },
      ],
      onDefault: "human-note",
    })
    .model("rationale", {
      label: "Write the rationale",
      prompt:
        "Proposal: {{steps.read.text}}\nExposure: {{steps.conflict.json}}\nDecision: {{steps.mandate.text}}\n\nWrite the rationale to publish with this vote. Cite the clause of the mandate it rests on, and state the strongest argument the other way.",
      next: "instruction",
    })
    .model("instruction", {
      label: "Hand the vote to the mandate owner",
      prompt:
        "Open proposals: {{steps.queue.json}}\nDecision: {{steps.mandate.text}}\nRationale: {{steps.rationale.text}}\n\nWrite the instruction the mandate owner acts on: the proposal id and its link, which of the proposal's own choices to pick and its position in that list, when voting closes, and the rationale to publish with it. Open by stating that nothing has been cast — a Snapshot vote is a signed message this crew cannot produce, so this is an instruction and not a record.",
      next: null,
    })
    .model("abstain-note", {
      label: "Record the abstention",
      prompt:
        "Proposal: {{steps.read.text}}\nExposure: {{steps.conflict.json}}\n\nWrite why the desk stood aside, and what would have to be true for it to vote next time.",
      next: null,
    })
    .model("human-note", {
      label: "Hand it to a human",
      prompt:
        "Proposal: {{steps.read.text}}\nExposure: {{steps.conflict.json}}\nDecision: {{steps.mandate.text}}\n\nWrite why this one is a human's decision rather than the desk's, and the smallest thing that would settle it. If the org stands to gain or lose money here, lead with that. If the sweep found nothing open, say that instead of implying a judgement was made.",
      next: null,
    })
    .build(),
};

/** Templates that make up the first-party crew blueprints. */
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
  lpRangeReview,
  yieldRotationCheck,
  riskSweep,
  governanceProposalSweep,
  governanceVoteCycle,
];
