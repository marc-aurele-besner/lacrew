/**
 * First-party crew blueprints.
 *
 * Two provenances, deliberately distinguishable. Three trace to a filled
 * design-partner intake and carry `intake.file`: every number in them answers a
 * question a real operator was asked. Three are author-drafted patterns with no
 * file — common team shapes whose caps and grants are a starting point somebody
 * reasoned about. Presenting them identically would lend partner-derived
 * authority to a guess, so the field is absent rather than pointed at a
 * document that does not exist.
 *
 * The patterns ship no flows on purpose. A blueprint's flows are the part most
 * specific to how one team actually works, and inventing them would be the same
 * fabrication one level down — these give the org shape, the budgets, the
 * guardrails and the standing directives, and leave the flows to whoever
 * installs them.
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
    { when: "A single article or dataset costs more than the analyst's cap", to: "research-lead", via: "escalation" },
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
      holds: "Root key; sole vote on the high tier. Owns what the desk is allowed to promise a customer.",
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
    { when: "A reply that would commit the company to something (refund, exception, deadline)", to: "human_root", via: "escalation" },
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
      holds: "Root key; sole vote on the high tier. The only seat that can widen what the crew may change.",
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
    { when: "A second remediation after the first did not restore service", to: "human_root", via: "escalation" },
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

export const crewBlueprints: CrewBlueprint[] = [
  defiDesk,
  githubExperts,
  contentStudio,
  researchDesk,
  supportDesk,
  platformOncall,
];

export function getCrewBlueprint(id: string): CrewBlueprint | undefined {
  return crewBlueprints.find((bp) => bp.id === id);
}
