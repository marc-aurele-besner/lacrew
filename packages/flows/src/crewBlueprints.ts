/**
 * First-party crew blueprints, one per filled design-partner intake.
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
      holds: "Root key; sole vote on the high tier. A co-signer for large treasury moves is a later change, not day one.",
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
      spends: ["model-api", "merge-authority"],
      tools: [
        "lacrew_check_policy",
        "lacrew_propose_intent",
        "lacrew_invoke_agent",
        "github.get_pull_request",
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
        "Reproduces the breakage, writes the minimal patch, and pushes to the bot's PR branch so CI can go green.",
      capUsdc: usdc(40),
      grantUsdc: usdc(60),
      spends: ["model-api", "ci-minutes", "sandbox-runner"],
      tools: ["lacrew_propose_intent", "lacrew_check_policy"],
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
  ],
  connectors: [
    {
      id: "github",
      routes: ["get_pull_request", "merge_pull_request"],
      usedBy: "flow",
      note: "Reads the PR being triaged and merges the ones that clear both the classifier and the merge-authority check. Register it as a GitHub App installation (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID) — that is the preset's default, and it scopes the crew to the repos the App was installed on rather than to a person's whole account. `--auth token` reads a PAT from GH_TOKEN instead. Either way the merge route is a write and carries the merge-authority policy target.",
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
      never: "A PR from an author impersonating a bot gets merged",
      enforcedBy: "flow",
      how: "Triage refuses unknown authors outright, and the merger acts only on a cleared verdict.",
      residualRisk:
        "This is orchestrator-side reasoning over PR metadata. GitHub's own app identity is the authority; pin the merge rule to the bot's app id in branch protection rather than trusting the classifier.",
    },
    {
      never: "A workflow-file edit is merged and exfiltrates secrets",
      enforcedBy: "external",
      how: "CODEOWNERS plus branch protection on `.github/workflows/**` require a human review the crew's token cannot satisfy. Triage routes such diffs to REJECT before that ever matters.",
    },
    {
      never: "Force-pushing or rewriting history on a default branch",
      enforcedBy: "external",
      how: "The App's token carries no force-push right and branch protection refuses it.",
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
  name: "Content studio",
  vertical: "content",
  summary:
    "Ideation, a staff writer, a three-seat review board, a visual packager, and a social desk under an editor manager. Everything ships as a draft: the publish endpoint is deliberately unadmitted, so publication is a DENY a human has to clear.",
  intake: {
    persona: "Founder running a personal brand and an organization brand, wanting a weekly content engine",
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
      boundary: "Read-only. Voice guidelines are changed by a human, not by the crew that follows them.",
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
    { change: "Admit the publishing endpoint — the change that turns drafts into posts", tier: "high" },
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

export const crewBlueprints: CrewBlueprint[] = [defiDesk, githubExperts, contentStudio];

export function getCrewBlueprint(id: string): CrewBlueprint | undefined {
  return crewBlueprints.find((bp) => bp.id === id);
}
