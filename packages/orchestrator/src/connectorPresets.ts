/**
 * Connector presets — the vetted definitions an operator would otherwise write
 * by hand.
 *
 * `connectors.ts` deliberately knows nothing about any particular service: a
 * connector is whatever the operator wrote down. That left a gap the shipped
 * crews walk straight into. The `github-experts` blueprint names
 * `github.get_pull_request` and `github.merge_pull_request`, and `lacrew crews
 * show github-experts` says to register them before the crew can work — with
 * nowhere to get them from. The operator transcribes a base URL, five paths,
 * two param allowlists and a policy target out of a docs snippet, and a
 * mistyped path surfaces as a 404 in the middle of a run rather than as a
 * refusal at boot.
 *
 * A preset is that transcription, done once and tested. It is *not* a new
 * privilege model: `buildConnectorPreset` returns a plain `Connector` that goes
 * through `validateConnector` and the same registry as a hand-written one. What
 * it removes is the copying, not the operator's decision.
 *
 * Two things a preset refuses to guess:
 *
 * 1. **The credential.** A preset names the environment variable it reads; it
 *    never carries a token, and a missing one fails the call rather than
 *    sending an unauthenticated request.
 * 2. **A write's policy target.** An address standing for "authority to merge"
 *    only exists once the crew is stood up, so a preset cannot know it. A write
 *    route that needs one is refused at build time unless the operator binds it
 *    — the alternative is shipping a merge route admitted by nothing, which is
 *    exactly the comfortable mistake the policy target exists to prevent.
 */

import type { Connector, ConnectorAuth, ConnectorRoute } from "./connectors.js";

/**
 * A preset's route. Same shape a connector route has, except `policyTarget` is
 * a *requirement* rather than a value: the address is the operator's to supply.
 */
export type ConnectorPresetRoute = Omit<ConnectorRoute, "policyTarget"> & {
  /**
   * Present on writes that must be admitted before they can be registered.
   * `note` says what the address stands for, so the operator binds the right
   * one rather than reusing a payee.
   */
  policyTarget?: { required: true; note: string };
};

/**
 * One way to authenticate a preset. A service may support more than one, and
 * they are not interchangeable in posture: a personal token carries whatever
 * its owner can reach, an app installation carries only what it was granted.
 * The preset states both so the operator picks rather than discovers.
 */
export type ConnectorPresetAuth =
  | {
      mode: "token";
      kind: "bearer" | "header";
      /** Header name for `kind: "header"`. */
      header?: string;
      env: string;
      label: string;
      /** Which token, and the narrowest scope that works. */
      note: string;
    }
  | {
      mode: "github-app";
      appIdEnv: string;
      privateKeyEnv: string;
      installationIdEnv: string;
      label: string;
      note: string;
    }
  | {
      /**
       * The genuinely public surfaces — the npm and PyPI registries. Declared
       * rather than left blank, so "this preset sends no credential" is a claim
       * the preset makes and a reader can check, and so `--token-env` against
       * one can be refused instead of silently ignored.
       */
      mode: "none";
      label: string;
      note: string;
    };

export type ConnectorPresetAuthMode = ConnectorPresetAuth["mode"];

export type ConnectorPreset = {
  /** Default connector id, and the name a config entry references. */
  id: string;
  title: string;
  /** What a crew uses it for. Printed by `lacrew connectors list`. */
  summary: string;
  /**
   * Default host. Absent when the service runs on the operator's own domain
   * (a Ghost blog) — `buildConnectorPreset` then refuses to build without one
   * rather than register a connector pointed at somebody else's site.
   */
  baseUrl?: string;
  /** What the operator's own base URL looks like, when there is no default. */
  baseUrlNote?: string;
  /** Supported credential modes, best-posture first. The first is the default. */
  auth: ConnectorPresetAuth[];
  /** Constant headers the service requires, e.g. an API version pin. */
  headers?: Record<string, string>;
  routes: ConnectorPresetRoute[];
};

export type ConnectorPresetOptions = {
  /** Override when the connector id must differ (two hosts, one service). */
  id?: string;
  /** Override for a self-hosted instance, e.g. GitHub Enterprise. Required when
   *  the preset ships no default host. */
  baseUrl?: string;
  /** Which credential mode to use. Defaults to the preset's first. */
  authMode?: ConnectorPresetAuthMode;
  /** Override the environment variable a `token`-mode credential is read from. */
  tokenEnv?: string;
  /**
   * Override the header a `token`-mode credential rides in. CoinGecko's Pro
   * tier is the same preset under a different host *and* a different header
   * name, which the env var override alone cannot express.
   */
  credentialHeader?: string;
  /** Override the env vars a `github-app` credential is read from. */
  appIdEnv?: string;
  privateKeyEnv?: string;
  installationIdEnv?: string;
  timeoutMs?: number;
  /**
   * Route name → the address standing for the authority to take that action.
   * Required for every route the preset marks; supplying one for a route that
   * does not take one is an error rather than a no-op.
   */
  policyTargets?: Record<string, `0x${string}`>;
  /**
   * Routes to leave out. A crew that only reads should not register the write:
   * the narrowest connector that does the job is the one to register.
   */
  omitRoutes?: string[];
};

/* ------------------------------------------------------------------ *
 * GitHub — the surface the `github-experts` crew works in
 * ------------------------------------------------------------------ */

const github: ConnectorPreset = {
  id: "github",
  title: "GitHub REST API",
  summary:
    "Reads pull requests, their files, and their CI state; merges the ones that clear policy. What the `github-experts` crew's triage flow calls.",
  baseUrl: "https://api.github.com",
  auth: [
    {
      mode: "github-app",
      appIdEnv: "GITHUB_APP_ID",
      privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
      installationIdEnv: "GITHUB_APP_INSTALLATION_ID",
      label: "GitHub App installation",
      note: "The right shape for a crew: scoped to the repos the App was installed on, its own identity in GitHub's audit log, and revocable without taking away a person's access. Install the App on the allowlisted accounts with Contents: read, Pull requests: read (write only if the merge route is registered), Checks: read. The registry mints and refreshes the hourly installation token itself.",
    },
    {
      mode: "token",
      kind: "bearer",
      env: "GH_TOKEN",
      label: "Personal access token",
      note: "Fine-grained PAT scoped to the allowlisted repos. Simpler to set up, but it carries its owner's access and every action the crew takes is attributed to that person. Prefer the App for anything long-lived.",
    },
  ],
  routes: [
    {
      name: "get_pull_request",
      method: "GET",
      path: "/repos/{owner}/{repo}/pulls/{number}",
      description: "One pull request: title, author, branches, mergeability, head SHA.",
      effect: "read",
    },
    {
      name: "list_pull_requests",
      method: "GET",
      path: "/repos/{owner}/{repo}/pulls",
      description: "Open pull requests on a repo — the watcher's queue.",
      effect: "read",
      params: ["state", "base", "sort", "direction", "per_page", "page"],
    },
    {
      name: "list_pull_request_files",
      method: "GET",
      path: "/repos/{owner}/{repo}/pulls/{number}/files",
      description: "Changed files and patches — what the reviewer classifies risk from.",
      effect: "read",
      params: ["per_page", "page"],
    },
    {
      name: "get_combined_status",
      method: "GET",
      path: "/repos/{owner}/{repo}/commits/{ref}/status",
      description: "Legacy commit statuses rolled up for a ref. Pass the PR's head SHA.",
      effect: "read",
      params: ["per_page", "page"],
    },
    {
      name: "list_check_runs",
      method: "GET",
      path: "/repos/{owner}/{repo}/commits/{ref}/check-runs",
      description:
        "Check runs for a ref — where GitHub Actions results live. Combined status alone reads green on a repo that only uses checks.",
      effect: "read",
      params: ["status", "filter", "per_page", "page"],
    },
    {
      name: "merge_pull_request",
      method: "PUT",
      path: "/repos/{owner}/{repo}/pulls/{number}/merge",
      description: "Merge a pull request. `sha` pins the head the decision was made against.",
      effect: "write",
      params: ["merge_method", "commit_title", "commit_message", "sha"],
      policyTarget: {
        required: true,
        note: "The crew's merge authority — not a payee. Admitting this address is a governance proposal; revoking it turns merging off org-wide without touching GitHub. In the `github-experts` blueprint this is the `merge-authority` target.",
      },
    },
  ],
};

/* ------------------------------------------------------------------ *
 * GitLab — the same triage and merge shape, on gitlab.com or self-hosted
 * ------------------------------------------------------------------ */

const gitlab: ConnectorPreset = {
  id: "gitlab",
  title: "GitLab API v4",
  summary:
    "Merge requests, their diffs, and their pipeline state; merges the ones that clear policy. The `github-experts` pattern for a crew whose code lives on GitLab.",
  baseUrl: "https://gitlab.com/api/v4",
  auth: [
    {
      mode: "token",
      kind: "header",
      header: "private-token",
      env: "GITLAB_TOKEN",
      label: "Project or group access token",
      note: "A project or group access token belongs to the project rather than to a person, which is the closest thing GitLab offers to GitHub's App posture. `read_api` is enough for the reads; the merge route needs `api`. Self-hosted: pass --base-url https://gitlab.example.com/api/v4.",
    },
  ],
  routes: [
    {
      name: "get_merge_request",
      method: "GET",
      path: "/projects/{id}/merge_requests/{iid}",
      description:
        "One merge request. `id` is the numeric project id or its path (`group/project` — the slash is encoded, which is the form GitLab expects); `iid` is the per-project number in the URL.",
      effect: "read",
    },
    {
      name: "list_merge_requests",
      method: "GET",
      path: "/projects/{id}/merge_requests",
      description: "Open merge requests on a project — the watcher's queue.",
      effect: "read",
      params: ["state", "target_branch", "source_branch", "scope", "order_by", "sort", "per_page", "page"],
    },
    {
      name: "list_merge_request_diffs",
      method: "GET",
      path: "/projects/{id}/merge_requests/{iid}/diffs",
      description: "Changed files and diffs — what the reviewer classifies risk from. GitLab 15.7+.",
      effect: "read",
      params: ["per_page", "page", "unidiff"],
    },
    {
      name: "list_merge_request_pipelines",
      method: "GET",
      path: "/projects/{id}/merge_requests/{iid}/pipelines",
      description: "Pipelines run for this merge request — where GitLab's CI verdict lives.",
      effect: "read",
      params: ["per_page", "page"],
    },
    {
      name: "merge_merge_request",
      method: "PUT",
      path: "/projects/{id}/merge_requests/{iid}/merge",
      description: "Merge a merge request. `sha` pins the head the decision was made against.",
      effect: "write",
      params: [
        "merge_commit_message",
        "squash_commit_message",
        "squash",
        "should_remove_source_branch",
        "merge_when_pipeline_succeeds",
        "sha",
      ],
      policyTarget: {
        required: true,
        note: "The crew's merge authority — not a payee. Revoking this address stops merging org-wide without touching GitLab or rotating the token.",
      },
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Package registries — what a dependency-bump reviewer reads instead of
 * guessing. Both are public: no credential, and the preset says so.
 * ------------------------------------------------------------------ */

const npm: ConnectorPreset = {
  id: "npm",
  title: "npm registry",
  summary:
    "Published versions, dist-tags, deprecations and repository links for a package. What a dependency-bump reviewer reads so the release notes in its summary are the real ones.",
  baseUrl: "https://registry.npmjs.org",
  auth: [
    {
      mode: "none",
      label: "No credential",
      note: "The public registry serves package metadata unauthenticated; a private registry is a different host and a different connector.",
    },
  ],
  routes: [
    {
      name: "get_package",
      method: "GET",
      path: "/{package}",
      description:
        "Every published version of a package, plus dist-tags. Scoped packages pass as `@scope/name` — the slash encodes to `%2F`, which is the form the registry expects.",
      effect: "read",
    },
    {
      name: "get_package_version",
      method: "GET",
      path: "/{package}/{version}",
      description:
        "One version's manifest: dependencies, engines, repository, deprecation notice. `version` also takes a dist-tag such as `latest`.",
      effect: "read",
    },
  ],
};

const pypi: ConnectorPreset = {
  id: "pypi",
  title: "PyPI JSON API",
  summary: "Release history, requires-python, and yanked releases for a Python package. The npm preset's counterpart for a Python dependency bot.",
  baseUrl: "https://pypi.org",
  auth: [
    {
      mode: "none",
      label: "No credential",
      note: "The JSON API is public and read-only; uploading is a different API this preset deliberately does not reach.",
    },
  ],
  routes: [
    {
      name: "get_project",
      method: "GET",
      path: "/pypi/{project}/json",
      description: "A project's metadata and its full release list.",
      effect: "read",
    },
    {
      name: "get_project_version",
      method: "GET",
      path: "/pypi/{project}/{version}/json",
      description: "One release: requires-python, dependencies, yanked reason if it was pulled.",
      effect: "read",
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Content surfaces — where the `content-studio` crew's pipeline ends.
 *
 * The blueprint's guardrail is that publishing is not the crew's to decide
 * alone, so every route that puts something in front of an audience carries a
 * required policy target, and the reads never do.
 * ------------------------------------------------------------------ */

const twitter: ConnectorPreset = {
  id: "twitter",
  title: "X / Twitter API v2",
  summary:
    "Reads timelines and search for the content crew's research step; posts what clears policy. The publish route is the crew's most public action, so it is the one that must be admitted.",
  baseUrl: "https://api.twitter.com/2",
  auth: [
    {
      mode: "token",
      kind: "bearer",
      env: "TWITTER_BEARER_TOKEN",
      label: "Bearer token",
      note: "An app-only bearer token covers the reads and cannot post, which is the safer default for a crew that only researches. `create_tweet` needs an OAuth 2.0 user-context token with `tweet.write` — the same header either way, so set this to whichever the crew is allowed to hold and omit the write when it is app-only.",
    },
  ],
  routes: [
    {
      name: "get_tweet",
      method: "GET",
      path: "/tweets/{id}",
      description: "One post, for quoting or replying to something a human pointed at.",
      effect: "read",
      params: ["tweet.fields", "expansions", "media.fields", "user.fields"],
    },
    {
      name: "search_recent_tweets",
      method: "GET",
      path: "/tweets/search/recent",
      description: "Last seven days matching a query — the research step's source material.",
      effect: "read",
      params: [
        "query",
        "max_results",
        "start_time",
        "end_time",
        "since_id",
        "until_id",
        "tweet.fields",
        "expansions",
        "next_token",
      ],
    },
    {
      name: "list_user_tweets",
      method: "GET",
      path: "/users/{id}/tweets",
      description: "An account's own recent posts — what the brand-voice check compares against.",
      effect: "read",
      params: ["max_results", "exclude", "start_time", "end_time", "tweet.fields", "pagination_token"],
    },
    {
      name: "create_tweet",
      method: "POST",
      path: "/tweets",
      description: "Publish. There is no draft state here — this is live the moment it returns 201.",
      effect: "write",
      params: ["text", "reply", "quote_tweet_id", "poll", "reply_settings", "media"],
      policyTarget: {
        required: true,
        note: "The crew's publishing authority. Revoking this address stops the crew posting immediately and org-wide, which is faster than rotating a token and does not break the reads.",
      },
    },
  ],
};

const typefully: ConnectorPreset = {
  id: "typefully",
  title: "Typefully",
  summary:
    "Files drafts and schedules them. Two write routes on one endpoint: `create_draft` cannot pass a schedule date because it is not in its allowlist, so filing a draft for a human and putting one on the wire are separately admitted.",
  baseUrl: "https://api.typefully.com/v1",
  auth: [
    {
      mode: "token",
      kind: "header",
      header: "x-api-key",
      env: "TYPEFULLY_API_KEY",
      label: "API key",
      note: "API key from Typefully → Settings → API. Set the env var to the literal `Bearer <key>` — Typefully expects that prefix inside the X-API-KEY header, and the value is sent verbatim.",
    },
  ],
  routes: [
    {
      name: "list_recently_scheduled",
      method: "GET",
      path: "/drafts/recently-scheduled/",
      description: "Drafts already queued — what the crew checks before adding to the queue.",
      effect: "read",
      params: ["content_filter"],
    },
    {
      name: "list_recently_published",
      method: "GET",
      path: "/drafts/recently-published/",
      description: "What has gone out, for the crew's own reporting.",
      effect: "read",
      params: ["content_filter"],
    },
    {
      name: "create_draft",
      method: "POST",
      path: "/drafts/",
      description:
        "File a draft. Nothing is published: no schedule date can be passed on this route, so the draft waits for a human in Typefully.",
      effect: "write",
      params: ["content", "threadify", "share"],
    },
    {
      name: "schedule_draft",
      method: "POST",
      path: "/drafts/",
      description:
        "File a draft with a schedule date, which sends it at that time with nobody looking again.",
      effect: "write",
      params: ["content", "threadify", "share", "schedule-date", "auto_retweet_enabled", "auto_plug_enabled"],
      policyTarget: {
        required: true,
        note: "The crew's publishing authority. Leave it unbound and the crew can still file drafts — that is the intended posture for a studio whose guardrail is that a human approves what ships.",
      },
    },
  ],
};

const ghost: ConnectorPreset = {
  id: "ghost",
  title: "Ghost Admin API",
  summary:
    "Reads the site's existing posts and files new ones. The publish decision lives in the request body (`status`), which a param allowlist cannot split, so every write here is admitted as publishing authority.",
  baseUrlNote:
    "Your own site: https://<site>/ghost/api/admin (Ghost Pro is https://<name>.ghost.io/ghost/api/admin).",
  auth: [
    {
      mode: "token",
      kind: "header",
      header: "authorization",
      env: "GHOST_ADMIN_TOKEN",
      label: "Admin API JWT",
      note: "The assembled header value `Ghost <jwt>`, not the Admin API key. Ghost signs a JWT from the key and caps it at five minutes, so this fits a token minted per run; a value left in the environment will start returning 401.",
    },
  ],
  headers: { "Accept-Version": "v5.0" },
  routes: [
    {
      name: "list_posts",
      method: "GET",
      path: "/posts/",
      description: "Existing posts — what the brand-voice step reads before drafting another.",
      effect: "read",
      params: ["filter", "limit", "page", "order", "formats", "include"],
    },
    {
      name: "get_post",
      method: "GET",
      path: "/posts/{id}/",
      description: "One post by id.",
      effect: "read",
      params: ["formats", "include"],
    },
    {
      name: "get_post_by_slug",
      method: "GET",
      path: "/posts/slug/{slug}/",
      description: "One post by slug, for checking whether the crew is about to duplicate it.",
      effect: "read",
      params: ["formats", "include"],
    },
    {
      name: "create_post",
      method: "POST",
      path: "/posts/",
      description:
        "Create a post. `posts` carries Ghost's array body, including `status` — so this route drafts or publishes depending on what the flow sends. Ghost's `?source=html` cannot be reached from here (query parameters are not sent on writes), so the body must be lexical or mobiledoc.",
      effect: "write",
      params: ["posts"],
      policyTarget: {
        required: true,
        note: "Publishing authority for the site. The body decides draft versus published, so admitting this address admits both — bind it only for a crew allowed to publish.",
      },
    },
    {
      name: "update_post",
      method: "PUT",
      path: "/posts/{id}/",
      description:
        "Update a post. This is how a draft becomes published, so it carries the same authority as creating one.",
      effect: "write",
      params: ["posts"],
      policyTarget: {
        required: true,
        note: "Publishing authority: flipping `status` to published is an update, not a create.",
      },
    },
  ],
};

const medium: ConnectorPreset = {
  id: "medium",
  title: "Medium API",
  summary:
    "An alternate publish surface for the content studio. Medium no longer issues integration tokens, so this preset is only usable by an account that already holds one — register it knowing that, or publish through Ghost.",
  baseUrl: "https://api.medium.com/v1",
  auth: [
    {
      mode: "token",
      kind: "bearer",
      env: "MEDIUM_INTEGRATION_TOKEN",
      label: "Integration token (legacy)",
      note: "A legacy integration token from Settings → Security and apps. Medium stopped issuing new ones, and there is no other credential this API takes — if the account has none, nothing here will authenticate.",
    },
  ],
  routes: [
    {
      name: "get_me",
      method: "GET",
      path: "/me",
      description: "The authenticated user, whose id the publish route needs.",
      effect: "read",
    },
    {
      name: "list_publications",
      method: "GET",
      path: "/users/{userId}/publications",
      description: "Publications the user may post to.",
      effect: "read",
    },
    {
      name: "create_post",
      method: "POST",
      path: "/users/{authorId}/posts",
      description:
        "Create a post. `publishStatus` in the body chooses draft, unlisted, or public — the same body-decides-visibility shape as Ghost.",
      effect: "write",
      params: [
        "title",
        "contentFormat",
        "content",
        "tags",
        "canonicalUrl",
        "publishStatus",
        "license",
        "notifyFollowers",
      ],
      policyTarget: {
        required: true,
        note: "Publishing authority for the account. `publishStatus: \"draft\"` is still this route, so admitting it admits publishing.",
      },
    },
  ],
};

const notion: ConnectorPreset = {
  id: "notion",
  title: "Notion API",
  summary:
    "Brand voice docs, style guides, and past posts as a read-only source of truth. No write route ships: the crew reads what the humans wrote and does not edit it.",
  baseUrl: "https://api.notion.com/v1",
  auth: [
    {
      mode: "token",
      kind: "bearer",
      env: "NOTION_TOKEN",
      label: "Internal integration secret",
      note: "Notion scopes access by what is shared with the integration, not by the token — share exactly the pages the crew should read and nothing else. That makes it closer to an App installation than to a personal token.",
    },
  ],
  // Notion refuses a request without a version pin, and the version decides the
  // response shape, so it belongs to the preset rather than to a caller.
  headers: { "Notion-Version": "2022-06-28" },
  routes: [
    {
      name: "search",
      method: "POST",
      path: "/search",
      description:
        "Pages and databases shared with the integration. A POST that reads — the query is a body, not an effect.",
      effect: "read",
      params: ["query", "filter", "sort", "page_size", "start_cursor"],
    },
    {
      name: "get_page",
      method: "GET",
      path: "/pages/{page_id}",
      description: "One page's properties.",
      effect: "read",
      params: ["filter_properties"],
    },
    {
      name: "get_block_children",
      method: "GET",
      path: "/blocks/{block_id}/children",
      description: "A page's actual content — Notion keeps the prose in blocks, not on the page.",
      effect: "read",
      params: ["page_size", "start_cursor"],
    },
    {
      name: "query_database",
      method: "POST",
      path: "/databases/{database_id}/query",
      description: "Rows of a database — a content calendar or a past-posts table.",
      effect: "read",
      params: ["filter", "sorts", "page_size", "start_cursor"],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Desk surfaces — market context and a dry run for the `defi-desk` crew.
 *
 * None of these execute anything. A swap is an onchain intent that goes
 * through `lacrew_propose_intent` and the policy stack; a connector that
 * could execute one would be a second execution path with none of that
 * enforcement, which is exactly what the desk's guardrails exist to prevent.
 * ------------------------------------------------------------------ */

const uniswap: ConnectorPreset = {
  id: "uniswap",
  title: "Uniswap v3 subgraph (The Graph)",
  summary:
    "Pool state, liquidity and recent swaps for quoting a candidate trade. Read-only by construction: execution is an onchain intent through the policy stack, never an HTTP call.",
  baseUrl: "https://gateway.thegraph.com/api",
  auth: [
    {
      mode: "token",
      kind: "bearer",
      env: "GRAPH_API_KEY",
      label: "Gateway API key",
      note: "The Graph gateway API key. Free-tier keys are rate limited; the desk's scanner should cache rather than poll.",
    },
  ],
  routes: [
    {
      name: "query",
      method: "POST",
      path: "/subgraphs/id/{subgraph_id}",
      description:
        "GraphQL against one subgraph — pools, tokens, ticks, swaps. `subgraph_id` is the deployment id, so which chain's Uniswap deployment the desk reads is the operator's choice, not the flow's.",
      effect: "read",
      params: ["query", "variables", "operationName"],
    },
  ],
};

const tenderly: ConnectorPreset = {
  id: "tenderly",
  title: "Tenderly simulation API",
  summary:
    "Dry-runs a call before the executor proposes it, so a revert is found off-chain. A simulation is a read — it is not an approval, and the verdict still comes from the policy stack.",
  baseUrl: "https://api.tenderly.co/api/v1",
  auth: [
    {
      mode: "token",
      kind: "header",
      header: "x-access-key",
      env: "TENDERLY_ACCESS_KEY",
      label: "Access token",
      note: "Tenderly access token from Settings → Authorization. The account and project slugs are route args, not credentials.",
    },
  ],
  routes: [
    {
      name: "simulate",
      method: "POST",
      path: "/account/{account}/project/{project}/simulate",
      description:
        "Simulate one transaction against a network at a block. Changes nothing anywhere, which is why it carries no policy target.",
      effect: "read",
      params: [
        "network_id",
        "block_number",
        "from",
        "to",
        "input",
        "gas",
        "gas_price",
        "value",
        "simulation_type",
        "save",
        "save_if_fails",
        "state_objects",
      ],
    },
    {
      name: "simulate_bundle",
      method: "POST",
      path: "/account/{account}/project/{project}/simulate-bundle",
      description: "Simulate an ordered bundle — an approve followed by a swap, as one outcome.",
      effect: "read",
      params: ["simulations"],
    },
  ],
};

const coingecko: ConnectorPreset = {
  id: "coingecko",
  title: "CoinGecko",
  summary:
    "Off-chain price and market context for the desk's scanner and risk step. Read-only; nothing here can move funds.",
  baseUrl: "https://api.coingecko.com/api/v3",
  auth: [
    {
      mode: "token",
      kind: "header",
      header: "x-cg-demo-api-key",
      env: "COINGECKO_API_KEY",
      label: "Demo API key",
      note: "Demo API key. Pro is the same routes on a different host under a different header — pass --base-url https://pro-api.coingecko.com/api/v3 and --credential-header x-cg-pro-api-key.",
    },
  ],
  routes: [
    {
      name: "simple_price",
      method: "GET",
      path: "/simple/price",
      description: "Spot prices for coin ids against one or more currencies.",
      effect: "read",
      params: [
        "ids",
        "vs_currencies",
        "include_market_cap",
        "include_24hr_vol",
        "include_24hr_change",
        "include_last_updated_at",
        "precision",
      ],
    },
    {
      name: "token_price",
      method: "GET",
      path: "/simple/token_price/{platform}",
      description: "Prices by contract address on one chain — how the desk prices what it actually holds.",
      effect: "read",
      params: [
        "contract_addresses",
        "vs_currencies",
        "include_market_cap",
        "include_24hr_vol",
        "include_24hr_change",
        "precision",
      ],
    },
    {
      name: "get_coin",
      method: "GET",
      path: "/coins/{id}",
      description: "One asset in full: market data, links, categories.",
      effect: "read",
      params: ["localization", "tickers", "market_data", "community_data", "developer_data", "sparkline"],
    },
    {
      name: "coin_market_chart",
      method: "GET",
      path: "/coins/{id}/market_chart",
      description: "Price, market cap and volume series — the risk step's volatility input.",
      effect: "read",
      params: ["vs_currency", "days", "interval", "precision"],
    },
    {
      name: "list_markets",
      method: "GET",
      path: "/coins/markets",
      description: "A ranked market page, for a scanner that starts from the top of the book.",
      effect: "read",
      params: ["vs_currency", "ids", "category", "order", "per_page", "page", "price_change_percentage"],
    },
  ],
};

/** Every preset that ships. */
export const connectorPresets: ConnectorPreset[] = [
  github,
  gitlab,
  npm,
  pypi,
  twitter,
  typefully,
  ghost,
  medium,
  notion,
  uniswap,
  tenderly,
  coingecko,
];

export function getConnectorPreset(id: string): ConnectorPreset | undefined {
  return connectorPresets.find((p) => p.id === id);
}

/** Route names a preset cannot register until the operator binds an address. */
export function presetPolicyTargetRoutes(preset: ConnectorPreset): string[] {
  return preset.routes.filter((r) => r.policyTarget?.required).map((r) => r.name);
}

/** The auth mode a set of options selects, defaulting to the preset's first. */
export function resolvePresetAuth(
  preset: ConnectorPreset,
  mode?: ConnectorPresetAuthMode,
): ConnectorPresetAuth {
  if (!mode) return preset.auth[0]!;
  const hit = preset.auth.find((a) => a.mode === mode);
  if (!hit) {
    throw new Error(
      `connector_preset_unknown_auth_mode:${preset.id}.${mode} (supported: ${preset.auth.map((a) => a.mode).join(", ")})`,
    );
  }
  return hit;
}

function buildAuth(auth: ConnectorPresetAuth, options: ConnectorPresetOptions): ConnectorAuth {
  if (auth.mode === "none") return { kind: "none" };
  if (auth.mode === "github-app") {
    return {
      kind: "github-app",
      appIdEnv: options.appIdEnv?.trim() || auth.appIdEnv,
      privateKeyEnv: options.privateKeyEnv?.trim() || auth.privateKeyEnv,
      installationIdEnv: options.installationIdEnv?.trim() || auth.installationIdEnv,
    };
  }
  const env = options.tokenEnv?.trim() || auth.env;
  return auth.kind === "bearer"
    ? { kind: "bearer", tokenEnv: env }
    : {
        kind: "header",
        header: options.credentialHeader?.trim() || auth.header || "authorization",
        valueEnv: env,
      };
}

/**
 * Resolve a preset into the plain `Connector` the registry takes.
 *
 * Everything here throws rather than degrades. A preset that quietly dropped an
 * unbound write would read to the flow author as "the tool does not exist yet",
 * and one that quietly ignored a misspelled `omitRoutes` entry would register a
 * write the operator believed they had left out.
 */
export function buildConnectorPreset(
  id: string,
  options: ConnectorPresetOptions = {},
): Connector {
  const preset = getConnectorPreset(id);
  if (!preset) {
    throw new Error(
      `unknown_connector_preset:${id} (available: ${connectorPresets.map((p) => p.id).join(", ")})`,
    );
  }

  // Resolved first: an unknown auth mode is a typo in the operator's own
  // config, and reporting an unbound policy target instead would send them to
  // fix the wrong line.
  const auth = resolvePresetAuth(preset, options.authMode);

  const known = new Set(preset.routes.map((r) => r.name));
  for (const name of options.omitRoutes ?? []) {
    if (!known.has(name)) throw new Error(`connector_preset_unknown_route:${id}.${name}`);
  }
  for (const name of Object.keys(options.policyTargets ?? {})) {
    if (!known.has(name)) throw new Error(`connector_preset_unknown_route:${id}.${name}`);
  }

  // Options that make no sense for this preset are reported before anything the
  // operator still has to bind: "that flag does not apply here" is a different
  // problem from "you have not supplied the address yet", and the first one
  // arriving second reads as though the binding was the mistake.
  if (auth.mode === "none" && (options.tokenEnv || options.credentialHeader)) {
    // Naming an env var for a preset that sends no credential means the operator
    // believes a token is going out. It is not, and finding that out from a
    // rate-limited public endpoint months later is worse than finding it here.
    throw new Error(`connector_preset_takes_no_credential:${id}`);
  }
  if (options.credentialHeader && !(auth.mode === "token" && auth.kind === "header")) {
    throw new Error(`connector_preset_credential_is_not_a_header:${id}`);
  }

  const omitted = new Set(options.omitRoutes ?? []);
  const routes: ConnectorRoute[] = [];
  for (const route of preset.routes) {
    if (omitted.has(route.name)) continue;
    const { policyTarget, ...rest } = route;
    const bound = options.policyTargets?.[route.name];
    if (policyTarget?.required && !bound) {
      throw new Error(
        `connector_preset_unbound_policy_target:${id}.${route.name} — ${policyTarget.note}`,
      );
    }
    if (bound && !policyTarget?.required) {
      // A read cannot carry one at all, and a write the preset did not mark is
      // one the operator is reasoning about from somewhere other than the
      // preset. Both are worth stopping on rather than silently honouring.
      throw new Error(`connector_preset_route_takes_no_policy_target:${id}.${route.name}`);
    }
    routes.push(bound ? { ...rest, policyTarget: bound } : rest);
  }
  if (routes.length === 0) throw new Error(`connector_preset_all_routes_omitted:${id}`);

  const baseUrl = options.baseUrl?.trim() || preset.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `connector_preset_unbound_base_url:${id} — ${preset.baseUrlNote ?? "this preset has no default host; pass one"}`,
    );
  }

  return {
    id: options.id?.trim() || preset.id,
    baseUrl,
    auth: buildAuth(auth, options),
    ...(preset.headers ? { headers: { ...preset.headers } } : {}),
    routes,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
}

/**
 * One entry of `LACREW_CONNECTORS`: either a connector written out in full, or
 * a preset reference with the operator's bindings.
 */
export type ConnectorConfigEntry = Connector | ({ preset: string } & ConnectorPresetOptions);

function isPresetRef(entry: ConnectorConfigEntry): entry is { preset: string } & ConnectorPresetOptions {
  return typeof (entry as { preset?: unknown }).preset === "string";
}

/** Expand preset references; pass full definitions through untouched. */
export function resolveConnectorConfig(entries: ConnectorConfigEntry[]): Connector[] {
  return entries.map((entry) => {
    if (!isPresetRef(entry)) return entry;
    const { preset, ...options } = entry;
    return buildConnectorPreset(preset, options);
  });
}
