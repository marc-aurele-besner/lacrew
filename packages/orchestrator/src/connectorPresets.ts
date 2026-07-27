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

import type { Connector, ConnectorRoute } from "./connectors.js";

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

export type ConnectorPreset = {
  /** Default connector id, and the name a config entry references. */
  id: string;
  title: string;
  /** What a crew uses it for. Printed by `lacrew connectors list`. */
  summary: string;
  baseUrl: string;
  /** Auth shape with the env var the operator is expected to set. */
  credential: {
    kind: "bearer" | "header";
    /** Header name for `kind: "header"`. */
    header?: string;
    env: string;
    /** Which token, and the narrowest scope that works. */
    note: string;
  };
  routes: ConnectorPresetRoute[];
};

export type ConnectorPresetOptions = {
  /** Override when the connector id must differ (two hosts, one service). */
  id?: string;
  /** Override for a self-hosted instance, e.g. GitHub Enterprise. */
  baseUrl?: string;
  /** Override the environment variable the credential is read from. */
  tokenEnv?: string;
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
  credential: {
    kind: "bearer",
    env: "GH_TOKEN",
    note: "Fine-grained personal access token or GitHub App installation token, scoped to the allowlisted repos. Contents: read, Pull requests: read (add write only if the merge route is registered), Checks: read.",
  },
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

/** Every preset that ships. */
export const connectorPresets: ConnectorPreset[] = [github];

export function getConnectorPreset(id: string): ConnectorPreset | undefined {
  return connectorPresets.find((p) => p.id === id);
}

/** Route names a preset cannot register until the operator binds an address. */
export function presetPolicyTargetRoutes(preset: ConnectorPreset): string[] {
  return preset.routes.filter((r) => r.policyTarget?.required).map((r) => r.name);
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

  const known = new Set(preset.routes.map((r) => r.name));
  for (const name of options.omitRoutes ?? []) {
    if (!known.has(name)) throw new Error(`connector_preset_unknown_route:${id}.${name}`);
  }
  for (const name of Object.keys(options.policyTargets ?? {})) {
    if (!known.has(name)) throw new Error(`connector_preset_unknown_route:${id}.${name}`);
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

  const env = options.tokenEnv?.trim() || preset.credential.env;
  return {
    id: options.id?.trim() || preset.id,
    baseUrl: options.baseUrl?.trim() || preset.baseUrl,
    auth:
      preset.credential.kind === "bearer"
        ? { kind: "bearer", tokenEnv: env }
        : { kind: "header", header: preset.credential.header ?? "authorization", valueEnv: env },
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
