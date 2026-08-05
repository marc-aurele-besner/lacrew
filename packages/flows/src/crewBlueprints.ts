/**
 * First-party crew blueprints.
 *
 * Two provenances, deliberately distinguishable. Three trace to a filled
 * design-partner intake and carry `intake.file`: every number in them answers a
 * question a real operator was asked. The rest are author-drafted patterns with
 * no file — common team shapes whose caps and grants are a starting point
 * somebody reasoned about. Presenting them identically would lend
 * partner-derived authority to a guess, so the field is absent rather than
 * pointed at a document that does not exist.
 *
 * Three of the patterns ship no flows, and that is a judgement about them
 * rather than a rule: how a support desk or an on-call rota actually works is
 * the part most specific to one team, and inventing it would be the same
 * fabrication one level down. They give the org shape, the budgets, the
 * guardrails and the standing directives, and leave the pipeline to whoever
 * installs them.
 *
 * The four DeFi patterns do ship a flow each, because their pipeline is the
 * claim being made. "This crew can only advise" is not a sentence in a summary
 * — it is a policy check the flow performs against a router nobody admitted,
 * and it is only checkable because the flow is there to run.
 *
 * Every number here traces to an answer: caps come from question 6 ("where's
 * your line"), grants from question 5 (the monthly budget, divided by the
 * epoch), the escalation ladder from question 6's third bullet, and each
 * guardrail from question 7 ("what must never happen") — paired with the layer
 * that actually refuses it. Where the honest answer is "LaCrew does not enforce
 * that", it says so in `residualRisk` or `outOfScope` rather than implying a
 * guarantee the chain never made.
 *
 * The personas are drafts, not signed partners (PRD F0.10). The shapes are
 * real; the addresses are not, which is why every blueprint binds by id.
 */

import type { CrewBlueprint } from "./crews.js";

/** USDC has six decimals; blueprints are written in dollars and stored in base units. */
const usdc = (dollars: number): string => BigInt(Math.round(dollars * 1_000_000)).toString();

const defiDesk: CrewBlueprint = {
  id: "defi-desk",
  caresFor: {
    kind: "venue",
    label: "Venues this desk trades",
    hint: "Add the DEXes and pools the desk is admitted to. A venue not listed here is one the crew has no business quoting.",
    placeholder: "Uniswap v3 · USDC/ETH 0.05%",
    notePlaceholder: "Depth, chain, or why this one is admitted",
  },
  name: "Opportunistic DeFi desk",
  vertical: "trading",
  summary:
    "Scanner, planner, executor, and rebalancer under a risk manager who can halt the desk. Trades ride a per-trade clip size; anything larger waits for the risk manager, and anything structural waits for the human.",
  intake: {
    persona: "Solo / small fund operator running a multi-agent trading desk across EVM DEXes",
    file: "design-partners/01-defi-opportunistic-trading.md",
  },
  epoch: "week",
  budget: {
    monthlyUsdMin: 2000,
    monthlyUsdMax: 5000,
    note: "Compute, RPCs, data APIs, and gas overhead. Trading inventory is separate working capital and is not streamed as an allowance.",
  },
  humanSeats: [
    {
      id: "operator",
      label: "Desk operator",
      holds:
        "Root key; sole vote on the high tier. A co-signer for large treasury moves is a later change, not day one.",
    },
  ],
  roles: [
    {
      id: "risk-manager",
      label: "Risk manager",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Reviews size, concentration, pool depth, and loss streaks. Approves or denies escalated trades, and halts the desk when the drawdown passes the kill threshold.",
      capUsdc: usdc(2000),
      grantUsdc: usdc(100),
      spends: ["model-api", "rpc-provider"],
      tools: ["lacrew_list_pending_intents", "lacrew_approve_intent", "lacrew_org_action"],
      flows: ["desk-kill-switch", "desk-venue-onboarding"],
    },
    {
      id: "scanner",
      label: "Market scanner",
      kind: "worker_agent",
      reportsTo: "risk-manager",
      charter:
        "Watches pools and price feeds across the admitted chains and surfaces candidates with expected PnL net of gas.",
      capUsdc: usdc(5),
      grantUsdc: usdc(150),
      spends: ["model-api", "data-feed", "rpc-provider"],
      tools: ["lacrew_check_policy", "lacrew_invoke_agent"],
      flows: ["desk-opportunity-scan"],
    },
    {
      id: "planner",
      label: "Route planner",
      kind: "worker_agent",
      reportsTo: "risk-manager",
      charter:
        "Turns a candidate into a concrete plan: swap path, inventory or flash-loan, chain, max slippage, deadline.",
      capUsdc: usdc(10),
      grantUsdc: usdc(200),
      spends: ["model-api", "sim-api", "rpc-provider"],
      tools: ["lacrew_check_policy"],
      flows: [],
    },
    {
      id: "executor",
      label: "Executor",
      kind: "worker_agent",
      reportsTo: "risk-manager",
      charter:
        "Simulates, then proposes the trade on admitted routers and pools only. Holds the desk's clip size and nothing beyond it.",
      capUsdc: usdc(200),
      grantUsdc: usdc(250),
      spends: ["dex-router", "flash-loan-pool", "sim-api", "rpc-provider"],
      tools: ["lacrew_propose_intent", "lacrew_check_policy"],
      flows: ["desk-execute-trade"],
      dedicatedPolicy:
        "the only seat that may touch routers and flash-loan pools; the org-wide whitelist cannot express that on its own",
    },
    {
      id: "rebalancer",
      label: "Treasury rebalancer",
      kind: "worker_agent",
      reportsTo: "risk-manager",
      charter:
        "Moves idle inventory between stablecoins and chains inside policy so the desk stays funded without touching the org treasury.",
      capUsdc: usdc(500),
      grantUsdc: usdc(50),
      spends: ["cold-wallet", "bridge", "rpc-provider"],
      tools: ["lacrew_propose_intent", "lacrew_check_policy"],
      flows: [],
    },
  ],
  targets: [
    {
      id: "rpc-provider",
      label: "RPC provider",
      kind: "service",
      whitelisted: true,
      note: "Multi-chain EVM RPC. Metered, and the one thing every seat needs.",
    },
    {
      id: "data-feed",
      label: "Price and liquidity feed",
      kind: "service",
      whitelisted: true,
      note: "Onchain reads plus a short list of indexers.",
    },
    {
      id: "model-api",
      label: "Model API",
      kind: "service",
      whitelisted: true,
      note: "Planning and review completions.",
    },
    {
      id: "sim-api",
      label: "Simulation service",
      kind: "service",
      whitelisted: true,
      note: "Dry-run before send. The executor's pre-flight assumes this ran.",
    },
    {
      id: "dex-router",
      label: "Admitted DEX routers",
      kind: "venue",
      whitelisted: true,
      note: "Uniswap v2/v3, PancakeSwap, and a short allowlist. Adding a family is a high-tier proposal.",
    },
    {
      id: "flash-loan-pool",
      label: "Admitted flash-loan pools",
      kind: "venue",
      whitelisted: true,
      note: "Only pools already on the approved template list.",
    },
    {
      id: "cold-wallet",
      label: "Designated cold wallet",
      kind: "payout",
      whitelisted: true,
      note: "The only address the desk may withdraw to. A second one is a high-tier proposal.",
    },
    {
      id: "bridge",
      label: "Bridges",
      kind: "venue",
      whitelisted: false,
      note: "Deliberately unadmitted. The rebalancer will attempt a cross-chain move and be denied until governance admits a specific bridge.",
    },
  ],
  connectors: [
    {
      id: "coingecko",
      routes: ["simple_price", "token_price", "coin_market_chart"],
      usedBy: "operator",
      note: "Off-chain price and volatility context for the scanner and the risk step. Read-only, and nothing here can move funds. Demo key in COINGECKO_API_KEY; Pro is the same routes under another host and header.",
    },
    {
      id: "uniswap",
      routes: ["query"],
      usedBy: "operator",
      note: "Pool state, liquidity and recent swaps for quoting a candidate, via the v3 subgraph. GRAPH_API_KEY. Reading only — executing a swap is an onchain intent through the policy stack, never an HTTP call, which is why no venue connector ships a write.",
    },
    {
      id: "tenderly",
      routes: ["simulate", "simulate_bundle"],
      usedBy: "operator",
      note: "Dry-run a call before the executor proposes it, so a revert is found off-chain. TENDERLY_ACCESS_KEY. A simulation is a read and not an approval; the verdict still comes from the policy stack.",
    },
  ],
  externalScopes: [
    {
      id: "rpc-keys",
      label: "RPC and data provider API keys",
      boundary:
        "Held by the orchestrator, scoped per provider. Rate limits are the provider's; LaCrew bounds what they cost, not what they return.",
    },
    {
      id: "cold-custody",
      label: "Cold wallet custody",
      boundary:
        "Hardware wallet held by the operator. LaCrew can restrict withdrawals to it; it cannot spend from it.",
    },
  ],
  escalation: [
    {
      when: "A trade above the executor's clip size but inside the desk's daily limit",
      to: "risk-manager",
      via: "escalation",
    },
    {
      when: "A pool or router the desk has not admitted",
      to: "human_root",
      via: "policy",
    },
    {
      when: "Any single trade or day that would move more than ~5% of the treasury",
      to: "human_root",
      via: "escalation",
    },
    {
      when: "A new chain, DEX family, flash-loan provider, or bridge",
      to: "human_root",
      via: "governance",
    },
    {
      when: "Drawdown past the kill threshold in an epoch",
      to: "human_root",
      via: "flow",
    },
  ],
  governance: [
    { change: "Admit a chain, DEX family, or flash-loan provider", tier: "high" },
    { change: "Admit a withdrawal address or a bridge", tier: "high" },
    { change: "Raise a seat's cap, or the desk's inventory", tier: "high" },
    { change: "Hire or fire the risk manager", tier: "high" },
    { change: "Hire or fire a worker seat", tier: "low" },
    { change: "Rotate an RPC or data vendor", tier: "low" },
  ],
  guardrails: [
    {
      never: "A seat pulls straight from the org treasury",
      enforcedBy: "treasury",
      how: "Treasury streams down the tree through EpochStreamer and seats spend their own allowance. There is no path from a leaf to the treasury balance.",
    },
    {
      never: "An open-ended call to a contract nobody admitted",
      enforcedBy: "policy",
      how: "WhitelistPolicy returns DENY for any target that is not admitted, and admission is a high-tier proposal with a timelock and a human veto.",
    },
    {
      never: "An unbounded ERC-20 approval to a router",
      enforcedBy: "policy",
      how: "An approval targets the token contract, so only tokens the org has admitted can be approved at all.",
      residualRisk:
        "Policy modules check (agent, target, value). The approval amount lives in calldata and is not decoded, so an unbounded approve to an admitted token is refused by nothing onchain — keep the executor on its own stack and watch it in Guardian.",
    },
    {
      never: "A withdrawal or bridge to an address that is not the cold wallet",
      enforcedBy: "policy",
      how: "The cold wallet is the only admitted payout target and no bridge is admitted, so both come back DENY until governance says otherwise.",
    },
    {
      never: "The executor proposes a trade nobody else looked at",
      enforcedBy: "flow",
      how: "Recommended: dual control (F2.32) on the executor seat in `spends_and_writes` with a clip-size threshold, so a propose above it parks until the desk manager concurs in the thread. `lacrew dual-control set --agent <executor> --mode spends_and_writes --min-spend <clip>`.",
      residualRisk:
        "Off-chain and off by default — an operator has to turn it on, and a manager agent concurring is review rather than trust, since whatever compromised the executor may reach it too. Caps, the whitelist and escalation are what actually bound the money.",
    },
    {
      never: "Unlimited spend from a compromised seat",
      enforcedBy: "session",
      how: "A run's session key carries maxValue = min(seat cap, flow scope cap) and expires; EscalationRouter reverts an over-ceiling propose with SessionValueExceeded.",
    },
    {
      never: "Chasing a losing strategy past the kill threshold",
      enforcedBy: "flow",
      how: "The kill switch runs every epoch, deactivates the executor on a HALT, and fails closed — an unreadable assessment halts.",
      residualRisk:
        "The loss is bounded by the epoch, not by the trade. Between two epoch runs the desk can only lose what the clip size and the daily limit allow.",
    },
  ],
  flows: [
    "desk-opportunity-scan",
    "desk-execute-trade",
    "desk-kill-switch",
    "desk-venue-onboarding",
  ],
  outOfScope: [
    "Latency-critical MEV and competitive arbitrage. Approval is human-timescale by construction, and a strategy that only wins with privileged mempool access should be passed on rather than automated here.",
    "Calldata semantics. Slippage bounds, deadlines, and approval amounts are checked in simulation and pre-flight, not by a policy module.",
    "Bridging. No bridge is admitted day one; the rebalancer's cross-chain step exists to be denied until one is.",
    "Execution as a connector. Presets now ship for the desk's market context — prices, pool state, a dry run — and the blueprint declares them, but no shipped flow calls one yet: the flows still reason over a candidate handed to them. Submitting a swap is not a connector at all; it is an onchain intent through the policy stack.",
    "Trading inventory as an allowance. Working capital sits in the treasury under governance, not in a seat's per-epoch stream.",
  ],
};

const githubExperts: CrewBlueprint = {
  id: "github-experts",
  caresFor: {
    kind: "repo",
    label: "Repos this crew looks after",
    hint: "Add the repositories the watcher ingests PRs from, as owner/repo. Note anything unusual per repo — a gas snapshot to regenerate, a protected branch, a slow CI job.",
    placeholder: "owner/repo",
    notePlaceholder: "Gas snapshot, protected branch, slow CI…",
  },
  name: "GitHub experts crew",
  vertical: "dev",
  summary:
    "Watcher, reviewer, merger, fixer, and a release scribe under a review lead. Off-chain work with an onchain budget: the repair loop stops when the allowance does.",
  intake: {
    persona: "Maintainer running many repos across personal accounts and orgs, drowning in bot PRs",
    file: "design-partners/02-github-experts-manager.md",
  },
  epoch: "week",
  budget: {
    monthlyUsdMin: 300,
    monthlyUsdMax: 1000,
    note: "Model usage, CI minutes beyond the free tier, and orchestration. No treasury — the allowance exists so a runaway fixer cannot run up an API bill overnight.",
  },
  humanSeats: [
    {
      id: "maintainer",
      label: "Maintainer",
      holds: "Root key; sole vote for personal-account repos.",
    },
    {
      id: "co-maintainer",
      label: "Org co-maintainer",
      holds:
        "High-tier vote for org repos: which orgs are watched, the GitHub permission set, and the monthly budget.",
    },
  ],
  roles: [
    {
      id: "review-lead",
      label: "Review lead",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Owns the queue and the budget. Clears escalated fixes, decides what waits for a human, and writes the weekly digest.",
      capUsdc: usdc(150),
      grantUsdc: usdc(25),
      spends: ["model-api"],
      tools: ["lacrew_list_pending_intents", "lacrew_approve_intent", "lacrew_set_budget"],
      flows: ["merge-window-digest"],
    },
    {
      id: "watcher",
      label: "Repo watcher",
      kind: "worker_agent",
      reportsTo: "review-lead",
      charter:
        "Ingests open PRs from Dependabot, Renovate, and other known bots across the allowlisted accounts, and keeps the queue with age and CI status.",
      capUsdc: usdc(5),
      grantUsdc: usdc(15),
      spends: ["model-api"],
      tools: ["lacrew_check_policy"],
      flows: [],
    },
    {
      id: "reviewer",
      label: "Reviewer",
      kind: "worker_agent",
      reportsTo: "review-lead",
      charter:
        "Reads the diff and the release notes, classifies risk, checks CI, and decides merge, fix, hold, or reject.",
      capUsdc: usdc(15),
      grantUsdc: usdc(40),
      spends: ["model-api", "merge-authority", "comment-authority"],
      tools: [
        "lacrew_check_policy",
        "lacrew_propose_intent",
        "lacrew_invoke_agent",
        "github.get_pull_request",
        "github.create_issue_comment",
        "github.merge_pull_request",
      ],
      flows: ["bot-pr-triage"],
    },
    {
      id: "merger",
      label: "Merger",
      kind: "worker_agent",
      reportsTo: "review-lead",
      charter:
        "Merges only what the reviewer and the policy both cleared: green CI, allowed labels, no outstanding human review request.",
      capUsdc: usdc(5),
      grantUsdc: usdc(10),
      spends: ["ci-minutes"],
      tools: ["lacrew_check_policy"],
      flows: [],
    },
    {
      id: "fixer",
      label: "Fixer",
      kind: "worker_agent",
      reportsTo: "review-lead",
      charter:
        "Reproduces the breakage, writes the minimal patch, and pushes to the bot's PR branch so CI can go green. It can write to the branches the connector was registered for and nowhere else — not the default branch, not the workflow files, and never by rewriting history.",
      capUsdc: usdc(40),
      grantUsdc: usdc(60),
      spends: ["model-api", "ci-minutes", "sandbox-runner", "push-authority"],
      tools: [
        "lacrew_propose_intent",
        "lacrew_check_policy",
        "github.list_pull_request_files",
        "github.get_file_raw",
        "github.get_ref",
        "github.get_commit",
        "github.create_tree",
        "github.create_commit",
        "github.update_ref",
      ],
      flows: ["dep-fix-loop"],
    },
    {
      id: "release-scribe",
      label: "Release scribe",
      kind: "worker_agent",
      reportsTo: "review-lead",
      charter:
        "Drafts the note when a batch of dependency merges lands. Drafts only — it does not tag or publish releases.",
      capUsdc: usdc(5),
      grantUsdc: usdc(10),
      spends: ["model-api"],
      tools: ["lacrew_check_policy"],
      flows: [],
    },
  ],
  targets: [
    {
      id: "model-api",
      label: "Model API",
      kind: "service",
      whitelisted: true,
      note: "Review and fix generation. The dominant line item.",
    },
    {
      id: "ci-minutes",
      label: "CI minutes",
      kind: "service",
      whitelisted: true,
      note: "Runner time beyond the free tier.",
    },
    {
      id: "sandbox-runner",
      label: "Sandbox runner",
      kind: "service",
      whitelisted: true,
      note: "Where a failing build is reproduced before a patch is written.",
    },
    {
      id: "merge-authority",
      label: "Merge authority",
      kind: "payout",
      whitelisted: true,
      note: "Not a payee — an address standing for permission to merge. The triage flow asks policy about it before merging and the connector re-checks it, so revoking this one address turns the crew's merge authority off org-wide in a single governance action, without touching GitHub.",
    },
    {
      id: "comment-authority",
      label: "Comment authority",
      kind: "payout",
      whitelisted: true,
      note: "Not a payee — an address standing for permission to speak on the crew's own pull requests. Deliberately separate from merge authority: the fix-note runs on the path where merging did *not* happen, so binding both to one address would mean revoking merge rights also silences the explanation of why a PR is stuck. Two addresses, two governance decisions.",
    },
    {
      id: "push-authority",
      label: "Push authority",
      kind: "payout",
      whitelisted: true,
      note: "Not a payee — an address standing for permission to write to a branch. The third of three, and separate for the same reason as the other two: a crew that may push is not thereby allowed to merge its own work, and revoking the push should not also silence the note explaining why the PR is stuck. What it admits is still bounded by the connector: the branches named at registration, no workflow files, no force, no history rewrite.",
    },
  ],
  connectors: [
    {
      id: "github",
      routes: [
        "get_pull_request",
        "list_pull_request_files",
        "get_file_raw",
        "get_ref",
        "get_commit",
        "create_issue_comment",
        "create_tree",
        "create_commit",
        "update_ref",
        "merge_pull_request",
      ],
      usedBy: "flow",
      note: "Reads the PR being triaged, reads and rewrites the one file the fix touches, posts the fixer's note back on it, and merges the ones that clear both the classifier and the merge-authority check. Register it as a GitHub App installation (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID) — that is the preset's default, and it scopes the crew to the repos the App was installed on rather than to a person's whole account. `--auth token` reads a PAT from GH_TOKEN instead. Each authority carries its own policy target — merge-authority, comment-authority, push-authority — and the push binds once (`--policy-target push_authority=0x…`) however many of git's object routes it takes, because it is one decision. It additionally refuses to register until `--branch` names the branches it may land on: `--branch 'dependabot/**' --branch 'renovate/**'` is what this crew works on.",
    },
  ],
  externalScopes: [
    {
      id: "github-app",
      label: "GitHub App installation",
      boundary:
        "Fine-grained, installed only on allowlisted accounts: read code, review PRs, merge, push to bot PR branches. GitHub enforces this, not LaCrew — the org chart bounds money, not repo access.",
    },
    {
      id: "branch-protection",
      label: "Branch protection and CODEOWNERS",
      boundary:
        "Default branches refuse force-pushes and history rewrites; `.github/workflows/**` requires a human owner's review. This is the layer that makes 'never touch workflows' real.",
    },
    {
      id: "notify-channel",
      label: "Escalation channel",
      boundary: "Outbound-only webhook to Slack, Telegram, or email. No inbound command path.",
    },
  ],
  escalation: [
    {
      when: "A major version bump, or a fix that would touch more than the failure requires",
      to: "review-lead",
      via: "flow",
    },
    {
      when: "A repair that costs more than the fixer's cap",
      to: "review-lead",
      via: "escalation",
    },
    {
      when: "Adding an org or a personal account to the watchlist",
      to: "human_root",
      via: "governance",
    },
    {
      when: "Expanding the GitHub App's permission set, or installing it somewhere new",
      to: "human_root",
      via: "external",
    },
    {
      when: "Merging with failing checks, changing branch protection, tagging a release",
      to: "human_root",
      via: "external",
    },
  ],
  governance: [
    { change: "Add or remove a watched org or repo", tier: "high" },
    { change: "Raise a seat's cap or the monthly budget", tier: "high" },
    { change: "Change the auto-merge policy (labels, semver band, required checks)", tier: "high" },
    { change: "Hire or fire the review lead", tier: "high" },
    { change: "Hire or fire a worker seat", tier: "low" },
    { change: "Rotate the model vendor", tier: "low" },
  ],
  guardrails: [
    {
      never: "A fix-until-green loop burns the month's API budget",
      enforcedBy: "policy",
      how: "Every attempt is one gated spend against the fixer's per-call cap, drawn from a per-epoch grant. The fix flow has no retry edge: when the allowance is spent, the loop stops because the money stopped.",
    },
    {
      never: "Spending with a vendor nobody approved",
      enforcedBy: "policy",
      how: "WhitelistPolicy denies any target that is not admitted; admitting one is a high-tier proposal.",
    },
    {
      never: "One seat both writes the change and merges it",
      enforcedBy: "flow",
      how: "Recommended: dual control (F2.32) on the merge path in `risky_writes`, so `github.merge_pull_request` parks until the review lead concurs in the thread. `lacrew dual-control set --crew <review-lead> --mode risky_writes --reviewer manager`.",
      residualRisk:
        "Off-chain and off by default. A reviewer agent on the same orchestrator is a second reading, not a second trust boundary — set `--reviewer role:human` for repos where a wrong merge is not recoverable.",
    },
    {
      never: "A PR from an author impersonating a bot gets merged",
      enforcedBy: "flow",
      how: "Triage refuses unknown authors outright, and the merger acts only on a cleared verdict.",
      residualRisk:
        "This is orchestrator-side reasoning over PR metadata. GitHub's own app identity is the authority; pin the merge rule to the bot's app id in branch protection rather than trusting the classifier.",
    },
    {
      never: "A workflow-file edit is merged and exfiltrates secrets",
      enforcedBy: "external",
      how: "CODEOWNERS plus branch protection on `.github/workflows/**` require a human review the crew's token cannot satisfy. Triage routes such diffs to REJECT before that ever matters, and the push route refuses `.github/workflows/` as a path argument, so the crew cannot author one either.",
    },
    {
      never: "The fixer writes to a branch nobody admitted",
      enforcedBy: "policy",
      how: "Two locks, and both have to be open. `push-authority` is an org-wide whitelist entry, so revoking one address stops every push the crew can make without touching GitHub; and the connector's push route was registered against a branch allowlist, so even an admitted crew can only land on `dependabot/**` and `renovate/**`. Widening either is a governance change rather than a run-time decision.",
    },
    {
      never: "Force-pushing or rewriting history on a default branch",
      enforcedBy: "policy",
      how: "There is no field to force with. The ref update the crew can make takes one argument — the commit — and the commit it builds takes exactly one parent, so a merge commit and an orphan are not expressible either. Without `force`, GitHub itself refuses anything that is not a fast-forward, which is what makes a branch that moved underneath a lost fix rather than a clobbered one. Branch protection and the App's own scope remain underneath as the layer LaCrew does not enforce.",
    },
    {
      never: "A fix adds a symlink or a submodule instead of a file",
      enforcedBy: "policy",
      how: "Every tree entry the crew can build is a regular file: `mode` and `type` are fixed at registration rather than allowlisted, so the values that mean symlink or submodule pointer are not representable in a call this crew can make.",
    },
    {
      never: "A repair rewrites a file nobody looked at",
      enforcedBy: "flow",
      how: "The fix path reads the failing file and the bump's own diff before the model writes anything, and the tree it builds is based on the branch's tree, so every file the fix does not name is carried through untouched.",
      residualRisk:
        "An entry naming a file the run did not read replaces that file in full, and nothing structural stops the model from writing one. What bounds it is the blast radius rather than the model's discipline: an allowlisted bot branch, at most twenty files, no workflow directory, and a human on the merge. A repo where that is not enough should set the push route to `ask` for every commit rather than only the first.",
    },
    {
      never: "GitHub permissions expand without the humans agreeing",
      enforcedBy: "governance",
      how: "Adding an account or widening the permission set is a high-tier proposal — timelocked, vetoable, and visible to both maintainer seats — and the install itself still requires a GitHub owner.",
    },
    {
      never: "Human-authored PRs are closed, or requested reviews dismissed",
      enforcedBy: "external",
      how: "The App is not granted review-dismissal; the crew's write scope is comments, merges, and pushes to bot branches.",
    },
  ],
  flows: ["bot-pr-triage", "dep-fix-loop", "merge-window-digest"],
  outOfScope: [
    "Repo authority. LaCrew governs the crew's money; what it may do inside GitHub is the App's permission set, and the two must be set up separately.",
    "Production deploy keys, secret rotation, and release publishing.",
    "CI providers other than GitHub Actions day one.",
    "Merging anything with failing checks. There is no override path in this blueprint by design.",
  ],
};

const contentStudio: CrewBlueprint = {
  id: "content-studio",
  caresFor: {
    kind: "account",
    label: "Accounts this studio writes for",
    hint: "Add each account by handle, and note its voice. The whole point of the crew is that two accounts never share a draft.",
    placeholder: "@handle",
    notePlaceholder: "Voice, audience, what it never posts",
  },
  name: "Content studio",
  vertical: "content",
  summary:
    "Ideation, a staff writer, a three-seat review board, a visual packager, and a social desk under an editor manager. Everything ships as a draft: the publish endpoint is deliberately unadmitted, so publication is a DENY a human has to clear.",
  intake: {
    persona:
      "Founder running a personal brand and an organization brand, wanting a weekly content engine",
    file: "design-partners/03-marketing-content-crew.md",
  },
  epoch: "week",
  budget: {
    monthlyUsdMin: 400,
    monthlyUsdMax: 1500,
    note: "Models, light image generation, and scheduling. The allowance exists to stop an image-generation or rewrite loop, not to fund a treasury.",
  },
  humanSeats: [
    {
      id: "founder",
      label: "Founder",
      holds: "Root key. Sole vote for the personal account.",
    },
    {
      id: "marketing-partner",
      label: "Marketing partner",
      holds:
        "High-tier vote for the organization brand: publish policy, connected accounts, budget raises, and hiring or firing a specialist seat.",
    },
  ],
  roles: [
    {
      id: "editor-manager",
      label: "Editor manager",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Owns the weekly pipeline and the budget. Clears escalated spend, arbitrates the review board, and assembles the sign-off package.",
      capUsdc: usdc(100),
      grantUsdc: usdc(30),
      spends: ["model-api", "publish-endpoint"],
      tools: ["lacrew_list_pending_intents", "lacrew_invoke_agent", "lacrew_set_budget"],
      flows: ["content-weekly-brief"],
    },
    {
      id: "ideation-lead",
      label: "Ideation lead",
      kind: "worker_agent",
      reportsTo: "editor-manager",
      charter:
        "Generates the weekly shortlist per account and runs the vote among the specialist seats.",
      capUsdc: usdc(10),
      grantUsdc: usdc(20),
      spends: ["model-api", "brand-assets"],
      tools: ["lacrew_check_policy", "lacrew_invoke_agent"],
      flows: [],
    },
    {
      id: "staff-writer",
      label: "Staff writer",
      kind: "worker_agent",
      reportsTo: "editor-manager",
      charter:
        "Turns the winning idea into a Medium-ready draft in that account's voice: headings, pull quote, image slots in place.",
      capUsdc: usdc(25),
      grantUsdc: usdc(60),
      spends: ["model-api", "brand-assets"],
      tools: ["lacrew_check_policy"],
      flows: [],
    },
    {
      id: "editor-voice",
      label: "Editor — brand voice",
      kind: "worker_agent",
      reportsTo: "editor-manager",
      charter: "Edits for tone, clarity, and consistency with the account's previous posts.",
      capUsdc: usdc(10),
      grantUsdc: usdc(15),
      spends: ["model-api", "brand-assets"],
      tools: ["lacrew_check_policy"],
      flows: [],
    },
    {
      id: "domain-expert",
      label: "Domain expert",
      kind: "worker_agent",
      reportsTo: "editor-manager",
      charter:
        "Checks factual and technical accuracy, and names any claim the studio cannot source.",
      capUsdc: usdc(10),
      grantUsdc: usdc(20),
      spends: ["model-api"],
      tools: ["lacrew_check_policy"],
      flows: [],
    },
    {
      id: "growth-seo",
      label: "Growth and SEO",
      kind: "worker_agent",
      reportsTo: "editor-manager",
      charter: "Titles, hooks, and discoverability — without keyword spam.",
      capUsdc: usdc(10),
      grantUsdc: usdc(15),
      spends: ["model-api"],
      tools: ["lacrew_check_policy"],
      flows: [],
    },
    {
      id: "visual-packager",
      label: "Visual packager",
      kind: "worker_agent",
      reportsTo: "editor-manager",
      charter:
        "Builds the image pack for an approved article: prompt, alt text, filename, and placement for the hero and each in-body slot.",
      capUsdc: usdc(20),
      grantUsdc: usdc(40),
      spends: ["model-api", "image-api"],
      tools: ["lacrew_propose_intent", "lacrew_check_policy"],
      flows: [],
    },
    {
      id: "social-desk",
      label: "Social desk",
      kind: "worker_agent",
      reportsTo: "editor-manager",
      charter:
        "Drafts three to five posts per account per day in that account's voice and queues them for review.",
      capUsdc: usdc(10),
      grantUsdc: usdc(20),
      spends: ["model-api", "scheduler", "publish-endpoint"],
      tools: ["lacrew_propose_intent", "lacrew_check_policy"],
      flows: ["content-daily-social"],
    },
  ],
  targets: [
    {
      id: "model-api",
      label: "Model API",
      kind: "service",
      whitelisted: true,
      note: "Ideation, drafting, review, and the brand-safety pass.",
    },
    {
      id: "image-api",
      label: "Image generation API",
      kind: "service",
      whitelisted: true,
      note: "Draft artwork only, capped tightly enough that a generation loop runs out before it gets interesting.",
    },
    {
      id: "scheduler",
      label: "Scheduling tool",
      kind: "service",
      whitelisted: true,
      note: "Where drafts queue. Draft mode only — see the credential boundary.",
    },
    {
      id: "brand-assets",
      label: "Brand asset store",
      kind: "service",
      whitelisted: true,
      note: "Voice guidelines, product facts, and past posts.",
    },
    {
      id: "publish-endpoint",
      label: "Publishing endpoint",
      kind: "payout",
      whitelisted: false,
      note: "Deliberately unadmitted. The pipeline's publish gate returns DENY, and the deny path is the human sign-off package. Opening it is a high-tier proposal both human seats can see.",
    },
  ],
  connectors: [
    {
      id: "notion",
      routes: ["search", "get_page", "get_block_children", "query_database"],
      usedBy: "operator",
      note: "Brand voice docs, style guides and past posts as a read-only source of truth. NOTION_TOKEN, and Notion scopes access by what is shared with the integration — share exactly the pages the crew should read. No write route ships: the crew reads what the humans wrote and does not edit it.",
    },
    {
      id: "typefully",
      routes: ["create_draft", "list_recently_scheduled"],
      usedBy: "operator",
      note: "Files the social desk's drafts so a human finds them queued rather than pasted into a message. TYPEFULLY_API_KEY. Register `create_draft` alone and nothing can go out — the scheduling route is a separate write that needs an address, and leaving it off is the posture this crew's publish gate already describes.",
    },
    {
      id: "ghost",
      routes: ["list_posts", "get_post_by_slug"],
      usedBy: "operator",
      note: "Reads the site's existing posts, so the crew checks what has already been said before drafting more. Needs your own base URL. The write routes are deliberately not listed: Ghost puts the publish decision in the request body, so registering one admits publishing, which this crew's guardrails keep with a human.",
    },
  ],
  externalScopes: [
    {
      id: "social-credentials",
      label: "Per-account social credentials",
      boundary:
        "Draft-and-schedule scopes only; no publish, no DM, no follow scopes are issued. Separate credentials per account, so one brand's key cannot post as the other.",
    },
    {
      id: "cms-token",
      label: "CMS token",
      boundary: "Draft-creation only. The publish mutation is not in the token's scope.",
    },
    {
      id: "brand-docs",
      label: "Brand documentation",
      boundary:
        "Read-only. Voice guidelines are changed by a human, not by the crew that follows them.",
    },
  ],
  escalation: [
    {
      when: "Publishing anything to the blog or a social account",
      to: "human_root",
      via: "policy",
    },
    {
      when: "A major topic pivot, or a claim about a competitor",
      to: "editor-manager",
      via: "flow",
    },
    {
      when: "Image spend above the packager's cap",
      to: "editor-manager",
      via: "escalation",
    },
    {
      when: "Connecting a new account, CMS, or scheduling tool",
      to: "human_root",
      via: "governance",
    },
    {
      when: "Raising the monthly budget or buying a new tool",
      to: "human_root",
      via: "governance",
    },
  ],
  governance: [
    {
      change: "Admit the publishing endpoint — the change that turns drafts into posts",
      tier: "high",
    },
    { change: "Connect a new account or publishing surface", tier: "high" },
    { change: "Raise a seat's cap or the monthly budget", tier: "high" },
    { change: "Hire or fire the editor manager", tier: "high" },
    { change: "Hire or fire a specialist seat", tier: "low" },
    { change: "Rotate the image or scheduling vendor", tier: "low" },
  ],
  guardrails: [
    {
      never: "Anything is published without a human",
      enforcedBy: "policy",
      how: "The publishing endpoint is not admitted, so the publish gate returns DENY and the flow's deny path assembles a sign-off package instead. Admitting it is a high-tier proposal — timelocked, vetoable, visible to both human seats.",
    },
    {
      never: "Image generation or a rewrite loop burns the month",
      enforcedBy: "policy",
      how: "The packager's per-call cap bounds one generation and its per-epoch grant bounds the week; the pipeline runs on a cron trigger once per account, not on demand.",
    },
    {
      never: "The same copy goes out on both brands",
      enforcedBy: "external",
      how: "Each account has its own credentials and its own scheduled run with its own brief; the social flow is written for one account at a time.",
      residualRisk:
        "Nothing onchain distinguishes the two brands. Separate credentials are the boundary that holds if a run is misconfigured.",
    },
    {
      never: "Fabricated quotes, invented statistics, or unreleased product details",
      enforcedBy: "flow",
      how: "The domain-expert seat names unsourceable claims during the vote, and the social flow's brand-safety step rewrites or drops a post before it can queue.",
      residualRisk:
        "A model checking a model is review, not enforcement. The human sign-off gate is the control that actually holds, which is why publication stays denied.",
    },
    {
      never: "A new social or CMS account is connected quietly",
      enforcedBy: "governance",
      how: "Connecting a publishing surface is a high-tier proposal, so the organization brand's second human seat sees it before it lands.",
    },
    {
      never: "Reply wars, mass DMs, or follow-unfollow growth hacks",
      enforcedBy: "external",
      how: "The issued credentials carry no engagement scopes; there is no code path to a reply or a DM.",
    },
    {
      never: "Spending on a tool nobody approved",
      enforcedBy: "policy",
      how: "WhitelistPolicy denies any target that is not admitted.",
    },
  ],
  flows: ["content-weekly-brief", "content-daily-social"],
  outOfScope: [
    "Publishing. This crew produces drafts, image packs, and review changelogs; the publish path stays closed until a human opens it by proposal.",
    "Analytics. Reading what performed is a later addition, not part of the v1 loop.",
    "Filing to the CMS or the scheduler automatically. Presets now ship for the draft surfaces and the blueprint declares the read routes plus Typefully's draft route, but no shipped flow calls one: the pipeline still produces the package and asks policy about publishing. An operator who wants the drafts filed registers these and wires the step.",
    "Editorial quality as an onchain property. LaCrew bounds what the crew spends and where — never what it writes.",
    "Paying several targets from one run without scoping its session key to cover them: a propose against a target the key is not issued for reverts at EscalationRouter rather than returning a verdict.",
    "A single voice across both brands. Two accounts means two briefs, two runs, and two sets of credentials.",
  ],
};

/* ------------------------------------------------------------------ *
 * Author-drafted patterns (no filled intake — see the note at the top)
 * ------------------------------------------------------------------ */

const researchDesk: CrewBlueprint = {
  id: "research-desk",
  name: "Research desk",
  vertical: "research",
  caresFor: {
    kind: "source",
    label: "Sources this desk tracks",
    hint: "Add the feeds, datasets and publications the scout watches. A source not listed is one the desk has no business citing.",
    placeholder: "arXiv cs.CR · https://export.arxiv.org/rss/cs.CR",
    notePlaceholder: "Paywalled, rate-limited, how far back it goes",
  },
  summary:
    "Scout, analyst, and librarian under a research lead. The work is reading and writing; the spending is metered data and model usage, which is exactly the bill that runs away unattended.",
  intake: {
    persona: "Analyst or small research team wanting continuous coverage of a moving field",
  },
  epoch: "week",
  budget: {
    monthlyUsdMin: 200,
    monthlyUsdMax: 800,
    note: "Model usage, paid data feeds, and article access. No treasury: the allowance exists so a scout that decides to read everything cannot spend a quarter's budget doing it.",
  },
  humanSeats: [
    {
      id: "lead",
      label: "Research lead",
      holds: "Root key; sole vote on the high tier. Decides what the desk is allowed to cite.",
    },
  ],
  roles: [
    {
      id: "research-lead",
      label: "Research lead agent",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Owns the question and the budget. Clears escalated purchases, decides what is worth deep reading, and refuses work that drifts from the brief.",
      capUsdc: usdc(120),
      grantUsdc: usdc(30),
      spends: ["model-api"],
      tools: ["lacrew_list_pending_intents", "lacrew_approve_intent", "lacrew_say"],
      flows: [],
    },
    {
      id: "scout",
      label: "Source scout",
      kind: "worker_agent",
      reportsTo: "research-lead",
      charter:
        "Sweeps the tracked sources for anything new that bears on the brief, and posts what it found rather than what it thinks about it.",
      capUsdc: usdc(15),
      grantUsdc: usdc(20),
      spends: ["model-api", "data-feed"],
      tools: ["lacrew_say", "lacrew_check_policy"],
      flows: [],
    },
    {
      id: "analyst",
      label: "Analyst",
      kind: "worker_agent",
      reportsTo: "research-lead",
      charter:
        "Reads deeply on what the scout surfaced and writes the argument, naming which source carries each claim.",
      capUsdc: usdc(60),
      grantUsdc: usdc(35),
      spends: ["model-api", "article-access"],
      tools: ["lacrew_say", "lacrew_ask"],
      flows: [],
    },
    {
      id: "librarian",
      label: "Librarian",
      kind: "worker_agent",
      reportsTo: "research-lead",
      charter:
        "Keeps the source list current: retires dead feeds, flags paywalled ones, and refuses to let an unattributed claim into the record.",
      capUsdc: usdc(10),
      grantUsdc: usdc(10),
      spends: ["model-api"],
      tools: ["lacrew_say", "lacrew_read_thread"],
      flows: [],
    },
  ],
  targets: [
    {
      id: "model-api",
      label: "Model provider",
      kind: "service",
      whitelisted: true,
      note: "Metered inference. Every seat needs it, which is why it is the one target the whole desk shares.",
    },
    {
      id: "data-feed",
      label: "Data feed",
      kind: "service",
      whitelisted: true,
      note: "Paid feeds the scout polls. Metered per call, which is why the scout's per-call cap is the tightest on the desk.",
    },
    {
      id: "article-access",
      label: "Article access",
      kind: "service",
      whitelisted: true,
      note: "Per-article purchases. The analyst is the only seat that buys these; a scout buying one has misread its job.",
    },
  ],
  externalScopes: [
    {
      id: "feed-keys",
      label: "Data feed API keys",
      boundary:
        "Whatever the provider scopes them to. LaCrew bounds what the desk may spend, not what a key may read — a key with wider access than the brief is the provider's setting to fix, not ours.",
    },
  ],
  connectors: [],
  escalation: [
    {
      when: "A single article or dataset costs more than the analyst's cap",
      to: "research-lead",
      via: "escalation",
    },
    { when: "A purchase exceeds the lead's own cap", to: "human_root", via: "escalation" },
    { when: "Adding a paid source to the tracked list", to: "human_root", via: "governance" },
  ],
  governance: [
    { change: "Admitting a new paid data source", tier: "high" },
    { change: "Raising the desk's monthly budget", tier: "high" },
    { change: "Hiring or retiring a seat", tier: "low" },
  ],
  guardrails: [
    {
      never: "A scout's sweep spends the month's data budget in an afternoon",
      enforcedBy: "policy",
      how: "The scout's per-call cap is the tightest on the desk and its grant is per epoch. A sweep that runs long stops when the allowance does, not when someone notices.",
    },
    {
      never: "Paying a data provider nobody admitted",
      enforcedBy: "policy",
      how: "WhitelistPolicy denies any target not on the list; admitting one is a high-tier proposal.",
    },
    {
      never: "A claim reaches the record with no source behind it",
      enforcedBy: "monitoring",
      how: "The librarian's charter is to refuse unattributed claims, and results posted to the thread carry the source they rest on.",
      residualRisk:
        "This is a disposition, not a gate. Nothing onchain refuses an unsourced sentence, and an analyst that fabricates a citation produces something a reader must still check. The desk makes fabrication visible, not impossible.",
    },
  ],
  flows: [],
  outOfScope: [
    "Publishing. The desk produces arguments; putting one in front of an audience is the content crew's job or a human's.",
    "Deciding what is true. Two sources disagreeing is a finding, and the desk is built to surface that rather than resolve it.",
    "Anything onchain. This crew reads and writes; its only spending is metered services.",
  ],
};

const supportDesk: CrewBlueprint = {
  id: "support-desk",
  name: "Support desk",
  vertical: "support",
  caresFor: {
    kind: "queue",
    label: "Inboxes this desk answers",
    hint: "Add each queue the triager reads, and note its promise — a queue with a one-hour SLA and one with a two-day SLA are not the same job.",
    placeholder: "support@ · Zendesk view 42",
    notePlaceholder: "SLA, who it is for, what never gets auto-answered",
  },
  summary:
    "Triager, responder, and an escalation writer under a support lead. Off-chain work with a real bill: model usage per ticket, which is the cost that scales with a bad week rather than a good one.",
  intake: {
    persona: "Small team drowning in a support queue that grows faster than headcount",
  },
  epoch: "week",
  budget: {
    monthlyUsdMin: 150,
    monthlyUsdMax: 600,
    note: "Model usage and helpdesk API calls. The allowance is per epoch so a spike week costs a spike week, not the quarter.",
  },
  humanSeats: [
    {
      id: "support-lead",
      label: "Support lead",
      holds:
        "Root key; sole vote on the high tier. Owns what the desk is allowed to promise a customer.",
    },
  ],
  roles: [
    {
      id: "desk-lead",
      label: "Desk lead agent",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Owns the queue and the budget. Clears escalated replies, decides what needs a human, and reports the week's shape rather than its volume.",
      capUsdc: usdc(60),
      grantUsdc: usdc(20),
      spends: ["model-api"],
      tools: ["lacrew_list_pending_intents", "lacrew_approve_intent", "lacrew_say"],
      flows: [],
    },
    {
      id: "triager",
      label: "Triager",
      kind: "worker_agent",
      reportsTo: "desk-lead",
      charter:
        "Reads each new ticket, classifies it, and routes it. Refuses to guess at a ticket it does not understand — an unclear ticket goes to a human, not to a plausible answer.",
      capUsdc: usdc(10),
      grantUsdc: usdc(15),
      spends: ["model-api", "helpdesk-api"],
      tools: ["lacrew_say", "lacrew_ask"],
      flows: [],
    },
    {
      id: "responder",
      label: "Responder",
      kind: "worker_agent",
      reportsTo: "desk-lead",
      charter:
        "Drafts replies for routine, well-understood tickets, citing the document the answer comes from. Never invents a policy the company does not have.",
      capUsdc: usdc(20),
      grantUsdc: usdc(25),
      spends: ["model-api", "helpdesk-api"],
      tools: ["lacrew_say", "lacrew_read_thread"],
      flows: [],
    },
  ],
  targets: [
    {
      id: "model-api",
      label: "Model provider",
      kind: "service",
      whitelisted: true,
      note: "Metered inference, billed per ticket handled. The cost that scales with a bad week.",
    },
    {
      id: "helpdesk-api",
      label: "Helpdesk API",
      kind: "service",
      whitelisted: true,
      note: "Reading and updating tickets. Metered on some plans, which is why it is a target rather than a free integration.",
    },
  ],
  externalScopes: [
    {
      id: "helpdesk-token",
      label: "Helpdesk API token",
      boundary:
        "The helpdesk's own permission model. A token that can close tickets can close them whatever LaCrew says — scope it to comment-and-tag if the desk is not trusted to resolve.",
    },
  ],
  connectors: [],
  escalation: [
    { when: "A ticket the triager cannot classify", to: "desk-lead", via: "escalation" },
    {
      when: "A reply that would commit the company to something (refund, exception, deadline)",
      to: "human_root",
      via: "escalation",
    },
    { when: "Adding a queue to the desk's care", to: "human_root", via: "governance" },
  ],
  governance: [
    { change: "Adding or removing a queue", tier: "high" },
    { change: "Raising the desk's budget", tier: "high" },
    { change: "Hiring or retiring a seat", tier: "low" },
  ],
  guardrails: [
    {
      never: "A bad week costs a quarter's budget",
      enforcedBy: "treasury",
      how: "Allowances stream per epoch and do not accumulate. A spike week spends a week's allowance and then the desk stops answering until the next refill — which is the signal a human wanted anyway.",
    },
    {
      never: "An agent promises a customer something the company has not agreed to",
      enforcedBy: "escalation",
      how: "Anything committing the company routes to the human root before it is sent. The responder's charter is routine tickets, and its cap is sized for them.",
      residualRisk:
        "The routing depends on the agent recognising a commitment as one. A reply that promises something without sounding like it does will go out — the desk narrows this, it does not close it.",
    },
    {
      never: "Spending with a vendor nobody approved",
      enforcedBy: "policy",
      how: "WhitelistPolicy denies any target not admitted; admitting one is a high-tier proposal.",
    },
  ],
  flows: [],
  outOfScope: [
    "Closing tickets without a human, where the resolution costs the company something. The desk drafts; a person commits.",
    "Anything requiring account access beyond the helpdesk token. Reading a customer's billing record is a permission the helpdesk grants, not one the org chart can.",
    "Phone and live chat. Both are real-time, and every guardrail here assumes a reply can wait for review.",
  ],
};

const platformOncall: CrewBlueprint = {
  id: "platform-oncall",
  name: "Platform on-call",
  vertical: "ops",
  caresFor: {
    kind: "service",
    label: "Services this crew watches",
    hint: "Add each service and note what 'down' means for it. A crew that cannot tell degraded from down will either page constantly or not at all.",
    placeholder: "api.example.com · prod",
    notePlaceholder: "What 'down' means here, and what may be restarted",
  },
  summary:
    "A monitor and a remediator under an on-call lead. The crew's power is deliberately asymmetric: it may look at anything and change almost nothing, because a remediation that misfires at 3am is worse than the incident.",
  intake: {
    persona: "Small platform team wanting first-response coverage without a rota nobody wants",
  },
  epoch: "week",
  budget: {
    monthlyUsdMin: 100,
    monthlyUsdMax: 400,
    note: "Model usage and metered observability queries. Deliberately small: this crew's value is attention, not spending.",
  },
  humanSeats: [
    {
      id: "platform-owner",
      label: "Platform owner",
      holds:
        "Root key; sole vote on the high tier. The only seat that can widen what the crew may change.",
    },
  ],
  roles: [
    {
      id: "oncall-lead",
      label: "On-call lead agent",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Holds the incident. Decides what is worth waking a human for, clears escalated remediations, and writes the timeline afterwards.",
      capUsdc: usdc(40),
      grantUsdc: usdc(15),
      spends: ["model-api"],
      tools: ["lacrew_list_pending_intents", "lacrew_approve_intent", "lacrew_say"],
      flows: [],
    },
    {
      id: "monitor",
      label: "Monitor",
      kind: "worker_agent",
      reportsTo: "oncall-lead",
      charter:
        "Watches the tracked services and reports what changed, with the query that shows it. Reports degradation as degradation and never as an outage.",
      capUsdc: usdc(15),
      grantUsdc: usdc(20),
      spends: ["model-api", "observability-api"],
      tools: ["lacrew_say", "lacrew_ask"],
      flows: [],
    },
    {
      id: "remediator",
      label: "Remediator",
      kind: "worker_agent",
      reportsTo: "oncall-lead",
      charter:
        "Proposes the smallest action that would restore service and says what it expects to happen. Acts only on the few remediations the owner has pre-agreed.",
      capUsdc: usdc(15),
      grantUsdc: usdc(10),
      spends: ["model-api"],
      tools: ["lacrew_say", "lacrew_check_policy"],
      flows: [],
    },
  ],
  targets: [
    {
      id: "model-api",
      label: "Model provider",
      kind: "service",
      whitelisted: true,
      note: "Metered inference. An incident is exactly when usage spikes, which is why the caps here are small.",
    },
    {
      id: "observability-api",
      label: "Observability provider",
      kind: "service",
      whitelisted: true,
      note: "Metered queries against logs and metrics. The monitor is the only seat that pays for them.",
    },
  ],
  externalScopes: [
    {
      id: "infra-credentials",
      label: "Infrastructure credentials",
      boundary:
        "The cloud provider's IAM, and the tightest boundary in this blueprint. LaCrew bounds what the crew may spend; what it may restart, scale, or delete is IAM's answer, and a credential that can delete a database can do so regardless of any cap here.",
    },
  ],
  connectors: [],
  escalation: [
    { when: "Any remediation the owner has not pre-agreed", to: "human_root", via: "escalation" },
    {
      when: "A second remediation after the first did not restore service",
      to: "human_root",
      via: "escalation",
    },
    { when: "Widening what the crew may change", to: "human_root", via: "governance" },
  ],
  governance: [
    { change: "Adding a pre-agreed remediation", tier: "high" },
    { change: "Adding a service to the watch list", tier: "low" },
    { change: "Hiring or retiring a seat", tier: "low" },
  ],
  guardrails: [
    {
      never: "A misfiring remediation loop makes an incident worse",
      enforcedBy: "escalation",
      how: "Only pre-agreed remediations run unattended, and a second attempt after a failed first goes to the human root. The loop cannot run itself twice.",
    },
    {
      never: "An incident's model usage outruns the month",
      enforcedBy: "treasury",
      how: "Grants stream per epoch and the caps here are the smallest in any first-party blueprint. An incident that costs a week's allowance stops the crew, and a stopped crew during an incident is a human's problem to notice — which beats a silent bill.",
    },
    {
      never: "The crew changes infrastructure nobody gave it access to",
      enforcedBy: "external",
      how: "The cloud provider's IAM decides this entirely. The org chart bounds money; it has no opinion about a delete.",
      residualRisk:
        "This is the blueprint's weakest boundary and the one worth reading twice: a credential scoped too widely makes every guardrail above cosmetic, and LaCrew cannot detect that it was.",
    },
  ],
  flows: [],
  outOfScope: [
    "Paging. Deciding who to wake and how is a rota tool's job; this crew decides that someone should be.",
    "Root-cause analysis. The crew writes what happened and when, not why — a timeline is evidence, an explanation is a claim.",
    "Anything requiring a deploy. Shipping a fix is the dev crew's work and goes through its own review.",
  ],
};

const lpAdvisor: CrewBlueprint = {
  id: "lp-advisor",
  name: "LP position advisor",
  vertical: "trading",
  caresFor: {
    kind: "position",
    label: "LP positions this crew advises on",
    hint: "Add the pools and the wallets holding liquidity in them. This crew advises on positions it does not own, so a wallet not listed here is one it has no business reading.",
    placeholder: "Aerodrome · WETH/USDC · 0x1f98…",
    notePlaceholder: "Chain, fee tier, and who actually executes a rebalance",
  },
  summary:
    "Mapper, range analyst, and a depth watch under an advisory lead. Reads liquidity positions in wallets it does not control and writes the rebalance a human executes. No venue and no payout address is admitted to it, so the advice is a structural fact rather than a promise.",
  intake: {
    persona:
      "Someone with liquidity spread across several chains and DEXes who wants a standing read on it without handing anyone the keys",
  },
  epoch: "week",
  budget: {
    monthlyUsdMin: 700,
    monthlyUsdMax: 1000,
    note: "Model usage, RPC reads, and subgraph queries. There is no trading inventory here at all — the crew never holds a position, so the only thing streaming is the cost of looking.",
  },
  humanSeats: [
    {
      id: "position-owner",
      label: "Position owner",
      holds:
        "Root key, and the wallets themselves. Executes every rebalance the crew recommends. The crew's output is a memo; this seat is what turns one into a transaction.",
    },
  ],
  roles: [
    {
      id: "advisory-lead",
      label: "Advisory lead",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Owns what the crew is willing to recommend. Reviews a rebalance before it reaches the owner and refuses the ones that rest on a number nobody read.",
      capUsdc: usdc(300),
      grantUsdc: usdc(60),
      spends: ["model-api", "rpc-provider", "payout-wallet"],
      tools: ["lacrew_check_policy", "lacrew_say"],
      flows: ["lp-range-review"],
    },
    {
      id: "position-mapper",
      label: "Position mapper",
      kind: "worker_agent",
      reportsTo: "advisory-lead",
      charter:
        "Resolves what a watched wallet actually holds: which pools, which ranges, how much liquidity, what fees have accrued. Reports a position it could not read as unread rather than as empty.",
      capUsdc: usdc(20),
      grantUsdc: usdc(50),
      spends: ["model-api", "rpc-provider", "data-feed"],
      tools: ["lacrew_check_policy", "lacrew_say"],
      flows: ["lp-range-review"],
    },
    {
      id: "range-analyst",
      label: "Range analyst",
      kind: "worker_agent",
      reportsTo: "advisory-lead",
      charter:
        "Judges each position against its range and its fees, and writes the concrete alternative: new bounds, size, and what moving costs. Will compute a rebalance and be refused when it tries to place one.",
      capUsdc: usdc(20),
      grantUsdc: usdc(45),
      spends: ["model-api", "data-feed", "dex-router"],
      tools: ["lacrew_check_policy"],
      flows: ["lp-range-review"],
    },
    {
      id: "depth-watch",
      label: "Depth watch",
      kind: "worker_agent",
      reportsTo: "advisory-lead",
      charter:
        "Watches pool depth and volume on the pools the crew advises on, so a recommendation that assumed liquidity is caught when the liquidity leaves.",
      capUsdc: usdc(20),
      grantUsdc: usdc(40),
      spends: ["model-api", "data-feed", "rpc-provider"],
      tools: ["lacrew_say"],
      flows: [],
    },
  ],
  targets: [
    {
      id: "model-api",
      label: "Model API",
      kind: "service",
      whitelisted: true,
      note: "Assessment and memo completions. The cost that scales with how many positions are watched.",
    },
    {
      id: "rpc-provider",
      label: "RPC provider",
      kind: "service",
      whitelisted: true,
      note: "Multi-chain EVM reads. Metered, and the only way to see a position at all.",
    },
    {
      id: "data-feed",
      label: "Pool and price feed",
      kind: "service",
      whitelisted: true,
      note: "Subgraph queries, pool APY history, and spot prices. Metered reads and nothing else.",
    },
    {
      id: "dex-router",
      label: "DEX routers",
      kind: "venue",
      whitelisted: false,
      note: "Deliberately unadmitted. The analyst computes a rebalance and is refused when it tries to place one, and the flow asks policy about this target on purpose so the refusal is recorded rather than assumed.",
    },
    {
      id: "payout-wallet",
      label: "Withdrawal address",
      kind: "payout",
      whitelisted: false,
      note: "There is no admitted withdrawal address. This crew has nowhere to send anything, which is a stronger claim than a small cap would be.",
    },
  ],
  connectors: [
    {
      id: "uniswap",
      routes: ["query"],
      usedBy: "flow",
      note: "Resolves a wallet's positions, ranges and accrued fees from the v3 subgraph. GRAPH_API_KEY. The review flow does not work until this is registered — which deployment id is read decides which chain, and that is the operator's choice.",
    },
    {
      id: "defillama-yields",
      routes: ["pool_chart"],
      usedBy: "operator",
      note: "APY and TVL history per pool, for judging whether a pool's fees are trending rather than sampling one day. Public, no credential. The shipped flow does not call it yet; wiring it is how the depth watch gets a baseline.",
    },
    {
      id: "coingecko",
      routes: ["simple_price"],
      usedBy: "operator",
      note: "Spot prices for valuing a position and estimating divergence loss against holding. COINGECKO_API_KEY. Not called by the shipped flow, which reasons over the subgraph's own figures.",
    },
  ],
  externalScopes: [
    {
      id: "rpc-keys",
      label: "RPC and subgraph API keys",
      boundary:
        "Held by the orchestrator, scoped per provider. They grant reads and only reads — but they grant reads of any address, and nothing in LaCrew narrows them to the watch list.",
    },
    {
      id: "wallet-custody",
      label: "The wallets themselves",
      boundary:
        "Held by the owner and never by the crew. LaCrew is not what stops the crew spending from them; not having the keys is.",
    },
  ],
  escalation: [
    {
      when: "A position in a pool or on a chain the crew was not asked to watch",
      to: "advisory-lead",
      via: "escalation",
    },
    {
      when: "Any recommendation that would place a trade rather than describe one",
      to: "human_root",
      via: "policy",
    },
    {
      when: "Policy answering ALLOW for a router — somebody admitted a venue to an advisory crew",
      to: "human_root",
      via: "flow",
    },
    {
      when: "Admitting a venue or a withdrawal address",
      to: "human_root",
      via: "governance",
    },
  ],
  governance: [
    { change: "Admitting a venue or a withdrawal address", tier: "high" },
    { change: "Raising a seat's cap", tier: "high" },
    { change: "Adding a wallet to the watch list", tier: "low" },
    { change: "Hiring or retiring a seat", tier: "low" },
  ],
  guardrails: [
    {
      never: "The crew moves a position it was only asked to look at",
      enforcedBy: "policy",
      how: "No venue and no payout target is admitted, so WhitelistPolicy returns DENY for every router and every withdrawal address. Admitting one is a high-tier proposal with a timelock and a human veto.",
    },
    {
      never: "A recommendation is mistaken for a rebalance that happened",
      enforcedBy: "flow",
      how: "The review flow asks `lacrew_check_policy` about the router and writes the memo on the refusal, so the memo states its own status. A run that somehow got ALLOW routes to an alert instead of a handoff.",
    },
    {
      never: "Reading a wallet nobody put on the watch list",
      enforcedBy: "monitoring",
      how: "The watch list is the crew's `caresFor` rows, and the run input names the owner being read. Guardian sees which addresses were queried.",
      residualRisk:
        "An RPC read is not a transaction. No policy module sees it and nothing onchain refuses it, so the watch list is a convention this crew keeps rather than a boundary anything enforces. A seat that reads a wallet it should not have read leaves a log entry, not a revert.",
    },
    {
      never: "A seat pulls straight from the org treasury",
      enforcedBy: "treasury",
      how: "Treasury streams down the tree through EpochStreamer and seats spend their own allowance. There is no path from a leaf to the treasury balance.",
    },
    {
      never: "Unlimited spend from a compromised seat",
      enforcedBy: "session",
      how: "A run's session key carries maxValue = min(seat cap, flow scope cap) and expires; EscalationRouter reverts an over-ceiling propose with SessionValueExceeded.",
    },
  ],
  flows: ["lp-range-review"],
  outOfScope: [
    "Executing rebalances. Not as a policy choice that could be relaxed — no venue is admitted, so there is nothing for an execution step to call. A crew that both advises and executes is a different blueprint with a different guardrail list.",
    "Impermanent loss as a realised number. What the crew reports is an estimate against a price path nobody re-ran, and a figure presented as realised PnL would be a claim the data does not support.",
    "Gas timing. Whether a rebalance is worth doing now rather than tonight depends on the mempool, and this crew reads pool state on a schedule.",
    "Custody of anything. The wallets belong to the owner. The crew's guarantee comes from not holding keys, which is a stronger property than any cap.",
  ],
};

const yieldDesk: CrewBlueprint = {
  id: "yield-desk",
  name: "Stablecoin yield desk",
  vertical: "trading",
  caresFor: {
    kind: "market",
    label: "Lending markets this desk is admitted to",
    hint: "Add each market the desk may allocate into, with its chain and asset. A market not listed here is one the allocator will be denied on until governance admits it.",
    placeholder: "Aave v3 · Base · USDC",
    notePlaceholder: "Chain, asset, and the ceiling you are comfortable leaving there",
  },
  summary:
    "Rate scout, risk scorer, and an allocator under a treasury lead. Parks idle stablecoins in admitted lending markets and rotates when the spread pays for the move. The risk control is not a model's opinion — it is which markets are on the whitelist at all.",
  intake: {
    persona:
      "A small treasury holding stablecoins it does not want idle, and does not want chasing whatever pays most this week either",
  },
  epoch: "week",
  budget: {
    monthlyUsdMin: 900,
    monthlyUsdMax: 1400,
    note: "Model usage, rate and TVL data, and the gas overhead of rotating. The capital being allocated is treasury under governance, not a seat's per-epoch stream.",
  },
  humanSeats: [
    {
      id: "treasurer",
      label: "Treasurer",
      holds:
        "Root key; sole vote on the high tier. Owns which protocols the desk is allowed to touch, which is the only decision here that really matters.",
    },
  ],
  roles: [
    {
      id: "treasury-lead",
      label: "Treasury lead agent",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Owns the allocation and the cash floor. Clears escalated moves, and reports what the desk earned against what it risked to earn it.",
      capUsdc: usdc(5000),
      grantUsdc: usdc(80),
      spends: ["model-api", "rpc-provider", "treasury-wallet"],
      tools: ["lacrew_list_pending_intents", "lacrew_approve_intent", "lacrew_say"],
      flows: ["yield-rotation-check"],
    },
    {
      id: "rate-scout",
      label: "Rate scout",
      kind: "worker_agent",
      reportsTo: "treasury-lead",
      charter:
        "Reads supply rates across the admitted markets and reports the spread against where the capital already sits, net of what moving costs.",
      capUsdc: usdc(25),
      grantUsdc: usdc(60),
      spends: ["model-api", "data-feed"],
      tools: ["lacrew_check_policy", "lacrew_say"],
      flows: ["yield-rotation-check"],
    },
    {
      id: "risk-scorer",
      label: "Risk scorer",
      kind: "worker_agent",
      reportsTo: "treasury-lead",
      charter:
        "Discounts a headline rate for what is underneath it: how much of the yield is emissions, how deep the market is, and whether the capital could actually be withdrawn on a bad day.",
      capUsdc: usdc(25),
      grantUsdc: usdc(50),
      spends: ["model-api", "data-feed"],
      tools: ["lacrew_say"],
      flows: [],
    },
    {
      id: "allocator",
      label: "Allocator",
      kind: "worker_agent",
      reportsTo: "treasury-lead",
      charter:
        "Proposes the move into an admitted market, in clip sizes, leaving the cash floor intact. The only seat that touches a lending market at all.",
      capUsdc: usdc(2000),
      grantUsdc: usdc(70),
      spends: [
        "aave-market",
        "morpho-market",
        "compound-market",
        "unadmitted-market",
        "rpc-provider",
      ],
      tools: ["lacrew_propose_intent", "lacrew_check_policy"],
      flows: ["yield-rotation-check"],
      dedicatedPolicy:
        "the only seat that may touch a lending market; the org-wide whitelist admits a market for every seat and cannot express that on its own",
    },
  ],
  targets: [
    {
      id: "model-api",
      label: "Model API",
      kind: "service",
      whitelisted: true,
      note: "Rate comparison and risk-scoring completions.",
    },
    {
      id: "data-feed",
      label: "Rate and TVL feed",
      kind: "service",
      whitelisted: true,
      note: "Reserve data and pool-level yield history. What the scout reads instead of guessing a rate.",
    },
    {
      id: "rpc-provider",
      label: "RPC provider",
      kind: "service",
      whitelisted: true,
      note: "Multi-chain EVM reads and the allocator's sends. Metered.",
    },
    {
      id: "aave-market",
      label: "Aave v3 markets",
      kind: "venue",
      whitelisted: true,
      note: "Admitted lending market. Adding a chain's deployment is a high-tier proposal, not a config change.",
    },
    {
      id: "morpho-market",
      label: "Morpho markets",
      kind: "venue",
      whitelisted: true,
      note: "Admitted lending market. Curated vaults have a curator, which is a trust assumption the risk scorer is expected to name.",
    },
    {
      id: "compound-market",
      label: "Compound v3 markets",
      kind: "venue",
      whitelisted: true,
      note: "Admitted lending market, single-borrow-asset by design, which is why it scores differently from the others.",
    },
    {
      id: "treasury-wallet",
      label: "Treasury wallet",
      kind: "payout",
      whitelisted: true,
      note: "The only address idle capital returns to. A second one is a high-tier proposal.",
    },
    {
      id: "unadmitted-market",
      label: "Every market nobody admitted",
      kind: "venue",
      whitelisted: false,
      note: "Deliberately unadmitted, as one entry. The allocator will find a better rate somewhere off this list and be refused — admission is the risk control here, so this refusal is the mechanism working rather than a gap in it.",
    },
  ],
  connectors: [
    {
      id: "aave",
      routes: ["query"],
      usedBy: "flow",
      note: "Supply and borrow rates, liquidity, caps and utilisation for the admitted markets. Public, no credential. The rotation check does not work until this is registered.",
    },
    {
      id: "defillama",
      routes: ["get_protocol_tvl"],
      usedBy: "flow",
      note: "The protocol's current TVL, so a rate is read alongside whether money is leaving the thing paying it. Public, no credential, and eighteen bytes per call.",
    },
    {
      id: "defillama-yields",
      routes: ["list_pools"],
      usedBy: "operator",
      note: "Every tracked pool's APY, its base and reward split, and TVL — how the scout would widen its search past the admitted list. Around eleven megabytes, so register a longer timeoutMs and filter it before a model sees it. Not called by the shipped flow.",
    },
  ],
  externalScopes: [
    {
      id: "rpc-keys",
      label: "RPC and data provider keys",
      boundary:
        "Held by the orchestrator, scoped per provider. Rate limits are the provider's; LaCrew bounds what they cost, not what they return.",
    },
  ],
  escalation: [
    {
      when: "An allocation larger than the allocator's clip size",
      to: "treasury-lead",
      via: "escalation",
    },
    {
      when: "A market the desk has not admitted",
      to: "human_root",
      via: "policy",
    },
    {
      when: "A move that would take the desk below its cash floor",
      to: "human_root",
      via: "flow",
    },
    {
      when: "Admitting a lending market, or raising the desk's total allocation",
      to: "human_root",
      via: "governance",
    },
  ],
  governance: [
    { change: "Admitting a lending market or a protocol", tier: "high" },
    { change: "Admitting a payout address", tier: "high" },
    { change: "Raising the allocator's cap or the desk's total allocation", tier: "high" },
    { change: "Rotating a data vendor", tier: "low" },
    { change: "Hiring or retiring a worker seat", tier: "low" },
  ],
  guardrails: [
    {
      never: "Capital lands in a market nobody admitted",
      enforcedBy: "policy",
      how: "WhitelistPolicy returns DENY for any target not admitted, and admitting one is a high-tier proposal with a timelock and a human veto. The allocator's own list includes an unadmitted entry precisely so this path is exercised rather than assumed.",
    },
    {
      never: "Any seat but the allocator moves capital into a market",
      enforcedBy: "policy",
      how: "The allocator carries a dedicated stack bound through EscalationRouter.setNodePolicy, because the org-wide whitelist admits a market for every seat and cannot separate them.",
    },
    {
      never: "The desk chases an emission APY into something it cannot exit",
      enforcedBy: "monitoring",
      how: "The risk scorer discounts the headline rate for the emission share and the market's depth, and the rotation flow asks whether the spread survives that haircut.",
      residualRisk:
        "Nothing onchain reads an APY. The haircut is a model's judgement, and a bad haircut produces a bad allocation into an *admitted* market — which every policy module answers ALLOW to, correctly. The whitelist bounds where the money can go, not whether going there was clever.",
    },
    {
      never: "The desk allocates everything and cannot pay its own costs",
      enforcedBy: "flow",
      how: "The rotation check is asked whether the move leaves the cash floor intact, and routes to a hold when it does not.",
      residualRisk:
        "The floor is a step in one pipeline. A run that never fires leaves it unchecked, and no contract knows the number — an allocation made outside this flow is bounded by the allocator's cap and nothing else.",
    },
    {
      never: "A seat pulls straight from the org treasury",
      enforcedBy: "treasury",
      how: "Treasury streams down the tree through EpochStreamer and seats spend their own allowance. The capital being allocated moves under governance, not as a seat's stream.",
    },
    {
      never: "Unlimited spend from a compromised seat",
      enforcedBy: "session",
      how: "A run's session key carries maxValue = min(seat cap, flow scope cap) and expires; EscalationRouter reverts an over-ceiling propose with SessionValueExceeded.",
    },
  ],
  flows: ["yield-rotation-check"],
  outOfScope: [
    "Anything but stablecoins. A desk that also held volatile collateral would need a liquidation guardrail, and none of the rails here are that.",
    "Leverage and looping. Recursive supply-and-borrow turns a rate into a liquidation price, which is a different job with a different escalation ladder.",
    "Bridging between chains. Moving capital across a bridge is not admitted, so a multi-chain rotation stops at the chain the capital is already on.",
    "The risk score as a fact. It is a model's discount on a headline number, and the blueprint says so in its guardrails rather than presenting it as diligence.",
  ],
};

const riskWatch: CrewBlueprint = {
  id: "risk-watch",
  name: "Protocol risk watch",
  vertical: "ops",
  caresFor: {
    kind: "protocol",
    label: "Protocols this crew watches",
    hint: "Add every protocol the org holds a position in, plus the oracle and the stable each one depends on. A protocol not listed here is one nobody is watching.",
    placeholder: "Ethena USDe · sUSDe vault · Ethereum",
    notePlaceholder: "The oracle it reads, and what a break in it would cost the org",
  },
  summary:
    "Peg watch, oracle watch, and an event watch under a risk lead. Watches the protocols the org already has money in and escalates — it can stop a sibling crew's seat, but it cannot unwind anything. Every guardrail here states what it still does not cover, because detection is not prevention.",
  intake: {
    persona:
      "An operator running several crews with real onchain exposure, who found out about the last depeg from a group chat",
  },
  epoch: "day",
  budget: {
    monthlyUsdMin: 400,
    monthlyUsdMax: 700,
    note: "Model usage and data reads at a half-hourly cadence. Sized per day rather than per week because a watch that stops mid-week is worse than one that never ran.",
  },
  humanSeats: [
    {
      id: "operator",
      label: "Operator",
      holds:
        "Root key; sole vote on the high tier. Decides whether a flagged protocol means unwinding, and does the unwinding — this crew never does.",
    },
  ],
  roles: [
    {
      id: "risk-lead",
      label: "Risk lead agent",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Owns the watch list and the thresholds. Decides when a signal is worth waking somebody for, and proposes deactivating the seat trading a protocol that has gone bad.",
      capUsdc: usdc(200),
      grantUsdc: usdc(6),
      spends: ["model-api", "remediation-venue"],
      tools: ["lacrew_org_action", "lacrew_list_pending_intents", "lacrew_say"],
      flows: ["risk-sweep"],
    },
    {
      id: "peg-watch",
      label: "Peg watch",
      kind: "worker_agent",
      reportsTo: "risk-lead",
      charter:
        "Watches the stables the org's positions depend on and reports a drift with the reading it came from, so a stale feed is legible as one afterwards.",
      capUsdc: usdc(10),
      grantUsdc: usdc(4),
      spends: ["model-api", "data-feed"],
      tools: ["lacrew_say"],
      flows: ["risk-sweep"],
    },
    {
      id: "oracle-watch",
      label: "Oracle watch",
      kind: "worker_agent",
      reportsTo: "risk-lead",
      charter:
        "Checks that the price feeds the watched protocols read are fresh and are still the feeds those protocols read. Reports the source alongside the number.",
      capUsdc: usdc(10),
      grantUsdc: usdc(4),
      spends: ["model-api", "data-feed", "rpc-provider"],
      tools: ["lacrew_say"],
      flows: [],
    },
    {
      id: "event-watch",
      label: "Event watch",
      kind: "worker_agent",
      reportsTo: "risk-lead",
      charter:
        "Watches admin and upgrade events on the watched protocols, and the governance proposals that would change a risk parameter before the parameter changes.",
      capUsdc: usdc(10),
      grantUsdc: usdc(4),
      spends: ["model-api", "rpc-provider", "indexer-api"],
      tools: ["lacrew_say", "lacrew_read_thread"],
      flows: [],
    },
  ],
  targets: [
    {
      id: "model-api",
      label: "Model API",
      kind: "service",
      whitelisted: true,
      note: "Assessment completions, every half hour, across every watched protocol. The cost that scales with the watch list.",
    },
    {
      id: "data-feed",
      label: "Price and TVL feed",
      kind: "service",
      whitelisted: true,
      note: "Spot prices, protocol TVL, and chain totals for the denominator. Metered reads.",
    },
    {
      id: "rpc-provider",
      label: "RPC provider",
      kind: "service",
      whitelisted: true,
      note: "Reading oracle freshness and protocol state directly, rather than trusting an aggregator to be current.",
    },
    {
      id: "indexer-api",
      label: "Indexer API",
      kind: "service",
      whitelisted: true,
      note: "Admin and upgrade events, and governance calldata. Metered, and the one surface where a risk parameter change is visible before it lands.",
    },
    {
      id: "remediation-venue",
      label: "Venues the org trades on",
      kind: "venue",
      whitelisted: false,
      note: "Deliberately unadmitted. This crew reports; it does not unwind. An attempt to exit a position on the protocol it just flagged comes back DENY, which is why the alert has to reach a human to be worth anything.",
    },
  ],
  connectors: [
    {
      id: "coingecko",
      routes: ["simple_price"],
      usedBy: "flow",
      note: "The peg reading. COINGECKO_API_KEY. The sweep does not work until this is registered — a peg watch with no price feed reports an all-clear on nothing.",
    },
    {
      id: "defillama",
      routes: ["get_protocol_tvl", "list_chains"],
      usedBy: "flow",
      note: "The protocol's TVL and the chain totals it is read against, so 'money is leaving' is distinguishable from 'money is leaving everywhere'. Public, no credential.",
    },
    {
      id: "aave",
      routes: ["query"],
      usedBy: "operator",
      note: "Reserve caps, LTV and liquidation thresholds — the parameter drift the event watch is looking for on a lending protocol. Public, no credential. Not called by the shipped sweep, which reads price and TVL.",
    },
  ],
  externalScopes: [
    {
      id: "data-keys",
      label: "Price, indexer and RPC keys",
      boundary:
        "Held by the orchestrator, scoped per provider. A rate limit hit here shows up as a sweep that read nothing, which is why the flow is written to say what it read.",
    },
    {
      id: "sibling-authority",
      label: "Authority over another crew's seat",
      boundary:
        "Granted by whoever passes this crew an executor address to halt. LaCrew bounds whether the deactivation lands; it does not decide whose seat was handed over.",
    },
  ],
  escalation: [
    {
      when: "A first signal on a watched protocol — a drift, a stale feed, an upgrade event",
      to: "risk-lead",
      via: "escalation",
    },
    {
      when: "A confirmed depeg, or TVL leaving a protocol faster than its chain",
      to: "human_root",
      via: "escalation",
    },
    {
      when: "Deactivating a seat that belongs to another crew",
      to: "human_root",
      via: "governance",
    },
    {
      when: "Anything that would have this crew trade rather than report",
      to: "human_root",
      via: "policy",
    },
  ],
  governance: [
    { change: "Deactivating a sibling crew's seat", tier: "high" },
    { change: "Hiring or firing the risk lead", tier: "high" },
    { change: "Adding or removing a protocol from the watch list", tier: "low" },
    { change: "Changing a threshold", tier: "low" },
  ],
  guardrails: [
    {
      never: "A depeg is noticed after the org is already out of the money",
      enforcedBy: "monitoring",
      how: "The sweep runs every half hour against the peg, the protocol's TVL, and the chain totals it is read against, and fails closed: an unreadable assessment routes to the halt rather than past it.",
      residualRisk:
        "Thirty minutes is the resolution. A peg that breaks and settles between two runs is invisible, and a run is only as good as the feed it read — which is why the flow is written to state what it read rather than only what it concluded.",
    },
    {
      never: "A flagged protocol keeps being traded by a sibling crew",
      enforcedBy: "escalation",
      how: "The sweep proposes deactivating the seat that trades it. Deactivation is reversible, so the flow reaches for it rather than for firing anyone.",
      residualRisk:
        "Deactivation is a proposal whenever policy escalates it, so the sibling crew keeps trading until somebody votes. The gap between the flag and the vote is the exposure, and the alert names which of the two states it is in for exactly that reason.",
    },
    {
      never: "This crew unwinds a position itself",
      enforcedBy: "policy",
      how: "No venue is admitted, so any attempt to trade on the protocol it just flagged comes back DENY.",
      residualRisk:
        "A DENY stops the trade, not the loss. Nothing here shortens the time between the alert and a human acting on it, and that interval is where the money actually goes.",
    },
    {
      never: "An oracle staleness alert on a feed nobody reads any more",
      enforcedBy: "monitoring",
      how: "The oracle watch reads freshness from the feed directly rather than from an aggregator's copy, and reports the source alongside the number.",
      residualRisk:
        "Freshness is read from the feed the crew was pointed at. A protocol that quietly switched oracles keeps reporting a fresh number from the wrong source, and the crew has no way to notice the switch — the watch list is maintained by a human.",
    },
    {
      never: "A seat pulls straight from the org treasury",
      enforcedBy: "treasury",
      how: "Treasury streams down the tree through EpochStreamer and seats spend their own allowance.",
      residualRisk:
        "The topology bounds the loss to a day's allowance, not to zero. A seat burning its stream on useless reads is a bill, and only Guardian will say so.",
    },
    {
      never: "Unlimited spend from a compromised seat",
      enforcedBy: "session",
      how: "A run's session key carries maxValue = min(seat cap, flow scope cap) and expires; EscalationRouter reverts an over-ceiling propose with SessionValueExceeded.",
      residualRisk:
        "A key that cannot overspend can still file a false all-clear, and an all-clear is the only thing this crew is really trusted for. The cap bounds the money and says nothing about the claim.",
    },
  ],
  flows: ["risk-sweep"],
  outOfScope: [
    "Remediation. The crew can stop a seat from trading; unwinding the position is the operator's, and the alert is written on the assumption that a person is about to do it.",
    "Paging. Deciding who to wake and how is a rota tool's job. This crew decides that someone should be.",
    "Root cause. The sweep writes what changed and when — an explanation of why would be a claim the readings do not support.",
    "The executor accounts themselves. The seat this crew may halt is handed to it as a run input, because a blueprint can only bind seats it owns. Halting across crews has no first-class shape yet.",
  ],
};

const governanceDesk: CrewBlueprint = {
  id: "governance-desk",
  name: "Governance delegate desk",
  vertical: "research",
  caresFor: {
    kind: "protocol",
    label: "Protocols this desk votes in",
    hint: "Add every protocol the org holds a governance token in, and the clause of the mandate that decides how the desk votes there. A protocol not listed here is one the desk has no standing in.",
    placeholder: "Compound · COMP · Tally",
    notePlaceholder: "The mandate clause that decides how this one is voted",
  },
  summary:
    "Proposal scout, rationale writer, and a conflict checker under a delegate lead. Votes the org's tokens against a written mandate and publishes why. Worth reading for what it admits: a vote moves no value, so the spend cap, the whitelist and the allowance all answer ALLOW, and none of them is what keeps this desk honest.",
  intake: {
    persona:
      "An org holding governance tokens in several protocols, currently voting late, inconsistently, or not at all",
  },
  epoch: "week",
  budget: {
    monthlyUsdMin: 350,
    monthlyUsdMax: 550,
    note: "Model usage for reading proposals and drafting rationales, plus the gas of casting votes. Proposals arrive weekly, so the allowance is sized weekly.",
  },
  humanSeats: [
    {
      id: "mandate-owner",
      label: "Mandate owner",
      holds:
        "Root key; sole vote on the high tier. Owns the written mandate, which is the only thing that decides how this desk votes — and is a document, not a policy module.",
    },
  ],
  roles: [
    {
      id: "delegate-lead",
      label: "Delegate lead agent",
      kind: "manager_agent",
      reportsTo: "root",
      charter:
        "Owns the desk's voting record. Clears the proposals that fall outside the mandate, casts the votes that fall inside it, and reads the published rationale against what was actually voted.",
      capUsdc: usdc(100),
      grantUsdc: usdc(32),
      spends: ["model-api", "rpc-provider", "governor-contract", "treasury-payout"],
      tools: ["lacrew_governance", "lacrew_list_pending_intents", "lacrew_say"],
      flows: ["governance-vote-cycle"],
    },
    {
      id: "proposal-scout",
      label: "Proposal scout",
      kind: "worker_agent",
      reportsTo: "delegate-lead",
      charter:
        "Reads a proposal and states what it changes rather than what its author says it changes. Refuses to summarise an executable payload it cannot decode.",
      capUsdc: usdc(10),
      grantUsdc: usdc(25),
      spends: ["model-api", "data-feed"],
      tools: ["lacrew_read_thread", "lacrew_say"],
      flows: ["governance-vote-cycle"],
    },
    {
      id: "rationale-writer",
      label: "Rationale writer",
      kind: "worker_agent",
      reportsTo: "delegate-lead",
      charter:
        "Writes the rationale published with each vote, citing the mandate clause it rests on and the strongest argument the other way.",
      capUsdc: usdc(10),
      grantUsdc: usdc(25),
      spends: ["model-api"],
      tools: ["lacrew_say"],
      flows: ["governance-vote-cycle"],
    },
    {
      id: "conflict-checker",
      label: "Conflict checker",
      kind: "worker_agent",
      reportsTo: "delegate-lead",
      charter:
        "Answers one question per proposal: does this organisation gain or lose money if it passes. Says so even when the connection is indirect, because that answer is what routes the proposal to a human.",
      capUsdc: usdc(10),
      grantUsdc: usdc(20),
      spends: ["model-api", "data-feed", "rpc-provider"],
      tools: ["lacrew_check_policy", "lacrew_say"],
      flows: [],
    },
  ],
  targets: [
    {
      id: "model-api",
      label: "Model API",
      kind: "service",
      whitelisted: true,
      note: "Reading proposals and drafting rationales. The bulk of what this desk costs.",
    },
    {
      id: "data-feed",
      label: "Holdings and proposal feed",
      kind: "service",
      whitelisted: true,
      note: "What the org holds, and the forum and proposal text the scout reads. Metered.",
    },
    {
      id: "rpc-provider",
      label: "RPC provider",
      kind: "service",
      whitelisted: true,
      note: "Reading voting power and proposal state onchain rather than trusting an interface's copy.",
    },
    {
      id: "governor-contract",
      label: "Governor contracts",
      kind: "venue",
      whitelisted: true,
      note: "Admitted, because casting a vote is a call to one. Worth stating plainly what that admission does and does not do: a vote transfers nothing, so the spend cap, the whitelist and the allowance all return ALLOW on it. The policy stack bounds this desk's money and not its votes.",
    },
    {
      id: "treasury-payout",
      label: "Withdrawal address",
      kind: "payout",
      whitelisted: false,
      note: "Deliberately unadmitted. A proposal that would route funds to this org can be voted on; the funds cannot be received by this crew.",
    },
  ],
  connectors: [],
  externalScopes: [
    {
      id: "delegation",
      label: "The org's delegated voting power",
      boundary:
        "Held by whoever delegated it, under the protocol's own governance contract. LaCrew can bound what this desk spends; the voting power is the protocol's to count and the delegator's to withdraw.",
    },
    {
      id: "mandate-doc",
      label: "The written mandate",
      boundary:
        "A document the mandate owner maintains. Nothing reads it but a model, and nothing enforces it but a human reading the rationale afterwards.",
    },
  ],
  escalation: [
    {
      when: "A proposal the written mandate does not cover",
      to: "delegate-lead",
      via: "escalation",
    },
    {
      when: "Any proposal that moves value to or from this org",
      to: "human_root",
      via: "escalation",
    },
    {
      when: "Changing the mandate, or who the org delegates to",
      to: "human_root",
      via: "governance",
    },
    {
      when: "Executing a proposal rather than voting on it",
      to: "human_root",
      via: "policy",
    },
  ],
  governance: [
    { change: "Changing the written mandate", tier: "high" },
    { change: "Changing who the org delegates its voting power to", tier: "high" },
    { change: "Adding a protocol the desk votes in", tier: "low" },
    { change: "Hiring or retiring a worker seat", tier: "low" },
  ],
  guardrails: [
    {
      never: "The desk votes outside the written mandate",
      enforcedBy: "monitoring",
      how: "The vote cycle decides against the mandate and publishes the clause it rested on, so the record and the reasoning land together for review.",
      residualRisk:
        "Nothing onchain reads a mandate. A vote is a call to a governor that moves no value, so the cap, the whitelist and the allowance all return ALLOW — correctly, and uselessly. What actually holds is the flow's routing and a human reading the rationale afterwards, which is a habit rather than a guarantee.",
    },
    {
      never: "A vote that unlocks money for this org is cast by the crew that benefits",
      enforcedBy: "escalation",
      how: "The conflict checker is asked about the org's exposure before the decision step, and anything touching it routes to the human root instead of to a vote.",
      residualRisk:
        "The escalation depends on the crew classifying the proposal correctly. A transfer hidden inside an executable payload reads as routine to a model, and no policy module decodes calldata — which is why the scout's charter is to refuse a payload it cannot decode rather than summarise it.",
    },
    {
      never: "The org's voting power is redelegated without a vote",
      enforcedBy: "governance",
      how: "Changing the delegate is a high-tier proposal with a timelock and a human veto.",
      residualRisk:
        "That covers a delegation LaCrew's governance module carries out. Tokens held anywhere else can be redelegated by whoever holds them, and this desk would not see it happen.",
    },
    {
      never: "The desk executes a proposal it voted on",
      enforcedBy: "policy",
      how: "No payout address is admitted, so anything routing funds through this crew comes back DENY, and the flow has no execute step.",
      residualRisk:
        "Execution targets the governor, which *is* admitted, and executing a ripe proposal moves no value from this org either. So 'never execute' is the flow's rule and the escalation ladder's, not the whitelist's — the whitelist only refuses the payout that would follow.",
    },
    {
      never: "A seat pulls straight from the org treasury",
      enforcedBy: "treasury",
      how: "Treasury streams down the tree through EpochStreamer and seats spend their own allowance.",
      residualRisk: "The topology bounds the loss to an epoch's allowance rather than to zero.",
    },
    {
      never: "Unlimited spend from a compromised seat",
      enforcedBy: "session",
      how: "A run's session key carries maxValue = min(seat cap, flow scope cap) and expires; EscalationRouter reverts an over-ceiling propose with SessionValueExceeded.",
      residualRisk:
        "The cap bounds the money. It says nothing about a vote, which is the only thing this desk does that matters — a compromised seat here votes wrong rather than spends.",
    },
  ],
  flows: ["governance-vote-cycle"],
  outOfScope: [
    "Finding the proposals. No Snapshot or Tally connector ships, so a proposal is handed to the flow rather than discovered by it. A desk that claimed to watch every forum would be claiming a surface that does not exist yet.",
    "Writing proposals for other organisations. Drafting is a different job from voting, and it carries a reputational exposure none of these rails touch.",
    "Forum engagement. The desk publishes a rationale; arguing for it in a thread is a person's work.",
    "Treating the vote as enforced. It is not, and the guardrails say so rather than implying the policy stack covers it.",
  ],
};

export const crewBlueprints: CrewBlueprint[] = [
  defiDesk,
  githubExperts,
  contentStudio,
  researchDesk,
  supportDesk,
  platformOncall,
  lpAdvisor,
  yieldDesk,
  riskWatch,
  governanceDesk,
];

export function getCrewBlueprint(id: string): CrewBlueprint | undefined {
  return crewBlueprints.find((bp) => bp.id === id);
}
