/**
 * `lacrew connectors …` — the connector definitions that ship, the config an
 * operator pastes into `LACREW_CONNECTORS` (F2.13), and the write policy those
 * routes run under (F2.24).
 *
 * `lacrew crews show github-experts` names the routes the crew calls and says
 * to register them first. This is where they come from. `list` / `show` /
 * `config` are fully offline: a preset is data, and `config` prints JSON rather
 * than writing anywhere, so what the operator admits stays their decision.
 *
 * `config` refuses to emit a write route with no policy target instead of
 * printing something that would fail at boot — the error names the address that
 * is missing and what it stands for.
 *
 * `mode`, `asks`, and `answer` talk to a running orchestrator, because a mode
 * is per-deployment state and an ask is a question waiting in a live thread.
 * `answer` posts an ordinary conversation message: there is no route that
 * resolves an ask directly, and adding one would be a second way to release a
 * write that the thread has no record of.
 */

import {
  buildConnectorPreset,
  connectorPresets,
  getConnectorPreset,
  presetPolicyTargetKey,
  presetPolicyTargetRoutes,
  DEFAULT_DENY_PATH_PREFIXES,
  DEFAULT_MAX_RESPONSE_BYTES,
  type ConnectorPreset,
  type ConnectorPresetAuthMode,
  type ConnectorPresetOptions,
} from "@lacrew/orchestrator";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

/** Every `--flag value` occurrence, so `--omit` and `--policy-target` repeat. */
function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((arg, i) => {
    const next = args[i + 1];
    if (arg === flag && next && !next.startsWith("-")) out.push(next);
  });
  return out;
}

function routeLine(preset: ConnectorPreset, name: string): string {
  const route = preset.routes.find((r) => r.name === name)!;
  const needs = [
    ...(route.policyTarget?.required ? ["a policy target"] : []),
    ...(route.guards?.branchArg ? ["a branch allowlist"] : []),
  ];
  const gate = needs.length > 0 ? `  ⚠ needs ${needs.join(" and ")}` : "";
  return `  ${route.effect === "write" ? "write" : "read "}  ${preset.id}.${route.name}  ${route.method} ${route.path}${gate}`;
}

/** Bytes as an operator writes them: "1 MB", not "1048576". */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** The env vars one credential mode reads — none, for a public API. */
function modeEnvVars(auth: ConnectorPreset["auth"][number]): string[] {
  if (auth.mode === "none") return [];
  if (auth.mode === "github-app") {
    return [auth.appIdEnv, auth.privateKeyEnv, auth.installationIdEnv];
  }
  return [auth.env];
}

function printList(): void {
  console.log("Connector presets\n");
  for (const preset of connectorPresets) {
    console.log(`  ${preset.id}  —  ${preset.title}`);
    console.log(`     ${preset.summary}`);
    console.log(
      `     auth: ${preset.auth.map((a) => a.mode).join(" | ")} (default ${preset.auth[0]!.mode})`,
    );
    console.log(
      `     routes: ${preset.routes.length} (${preset.routes.filter((r) => r.effect === "write").length} write)`,
    );
    console.log("");
  }
  console.log("Detail:  lacrew connectors show <id>");
  console.log("Config:  lacrew connectors config <id> --policy-target <name>=0x…");
}

function printShow(id: string): void {
  const preset = getConnectorPreset(id);
  if (!preset) {
    console.error(`Unknown preset "${id}". Known: ${connectorPresets.map((p) => p.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${preset.title}  (${preset.id})\n`);
  console.log(preset.summary);
  console.log(
    `\nBase URL   ${preset.baseUrl ?? `⚠ none — pass --base-url. ${preset.baseUrlNote ?? ""}`}`,
  );
  if (preset.headers) {
    console.log(
      `Headers    ${Object.entries(preset.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}`,
    );
  }

  // Modes are listed best-posture first, and the default is the first, so an
  // operator who reads top-down lands on the one they should be using.
  console.log("\nCredential modes");
  preset.auth.forEach((auth, i) => {
    const envVars = modeEnvVars(auth);
    console.log(`  ${auth.mode}${i === 0 ? "  (default)" : ""}  —  ${auth.label}`);
    console.log(`      env: ${envVars.length > 0 ? envVars.join(", ") : "none (public API)"}`);
    console.log(`      ${auth.note}`);
  });

  console.log("\nRoutes");
  for (const route of preset.routes) {
    console.log(routeLine(preset, route.name));
    if (route.description) console.log(`         ${route.description}`);
    if (route.params?.length) console.log(`         args: ${route.params.join(", ")}`);
    if (route.policyTarget) console.log(`         target: ${route.policyTarget.note}`);
    if (route.guards?.branchArg) {
      console.log(
        `         branches: "${route.guards.branchArg}" is refused unless it matches --branch. There is no default.`,
      );
    }
    if (route.guards?.pathArg) {
      console.log(
        `         paths: "${route.guards.pathArg}" refuses ${DEFAULT_DENY_PATH_PREFIXES.join(", ")} unless --deny-path replaces the list.`,
      );
    }
    const capped = Object.entries(route.argRules ?? {}).filter(([, r]) => r.maxBytes !== undefined);
    for (const [arg, rule] of capped) {
      console.log(`         max ${arg}: ${formatBytes(rule.maxBytes!)}`);
    }
    if (route.maxResponseBytes) {
      console.log(
        `         max response: ${formatBytes(route.maxResponseBytes)} (raised for this route)`,
      );
    }
  }

  console.log(
    `\nResponses over ${formatBytes(DEFAULT_MAX_RESPONSE_BYTES)} are refused with` +
      ` connector_response_too_large, unless a route above raises its own limit.`,
  );

  // By binding name, not by route: the four calls of an atomic push name one
  // authority, and printing four lines would read as four decisions.
  const gated = presetPolicyTargetRoutes(preset);
  const branched = preset.routes.filter((r) => r.guards?.branchArg);
  const needsBaseUrl = preset.baseUrl === undefined;
  if (gated.length > 0 || needsBaseUrl) {
    console.log("\nBind before registering");
    if (needsBaseUrl) console.log("  --base-url https://…");
    for (const name of gated) {
      const shared = preset.routes.filter((r) => presetPolicyTargetKey(r) === name);
      const covers = shared.length > 1 ? `   (admits ${shared.map((r) => r.name).join(", ")})` : "";
      console.log(`  --policy-target ${name}=0x…${covers}`);
    }
    if (branched.length > 0) console.log("  --branch '<glob>'   (repeatable)");
    if (gated.length > 0) {
      const writes = preset.routes.filter((r) => r.policyTarget?.required).map((r) => r.name);
      console.log("  Or leave the write out entirely:");
      console.log(`  --omit ${writes.join(" --omit ")}`);
    }
  }

  console.log(
    `\nEmit it:  lacrew connectors config ${preset.id}${needsBaseUrl ? " --base-url https://…" : ""}${gated
      .map((name) => ` --policy-target ${name}=0x…`)
      .join("")}${branched.length > 0 ? " --branch 'dependabot/**'" : ""}`,
  );
}

/** `--policy-target merge_pull_request=0x…` → the bindings map. */
function parsePolicyTargets(args: string[]): Record<string, `0x${string}`> {
  const out: Record<string, `0x${string}`> = {};
  for (const pair of flagValues(args, "--policy-target")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--policy-target expects <route>=<address>, got "${pair}"`);
    const route = pair.slice(0, eq);
    const address = pair.slice(eq + 1);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`--policy-target ${route}: "${address}" is not a 0x address`);
    }
    out[route] = address as `0x${string}`;
  }
  return out;
}

function printConfig(id: string, args: string[]): void {
  const policyTargets = parsePolicyTargets(args);
  const omitRoutes = flagValues(args, "--omit");
  const branches = flagValues(args, "--branch");
  const denyPaths = flagValues(args, "--deny-path");
  const authMode = flagValue(args, "--auth") as ConnectorPresetAuthMode | undefined;
  const options: ConnectorPresetOptions = {
    ...(authMode ? { authMode } : {}),
    ...(flagValue(args, "--base-url") ? { baseUrl: flagValue(args, "--base-url") } : {}),
    ...(flagValue(args, "--token-env") ? { tokenEnv: flagValue(args, "--token-env") } : {}),
    ...(flagValue(args, "--credential-header")
      ? { credentialHeader: flagValue(args, "--credential-header") }
      : {}),
    ...(flagValue(args, "--id") ? { id: flagValue(args, "--id") } : {}),
    ...(Object.keys(policyTargets).length > 0 ? { policyTargets } : {}),
    ...(omitRoutes.length > 0 ? { omitRoutes } : {}),
    ...(branches.length > 0 ? { branches } : {}),
    // An empty `--deny-path ''` is how an operator says "keep only the
    // platform's own protections", and it has to be distinguishable from not
    // passing the flag at all, which keeps the default.
    ...(args.includes("--deny-path") ? { denyPathPrefixes: denyPaths } : {}),
  };
  // Throws rather than emits when a write is unbound: config that would stop
  // the orchestrator at boot is worse than an error here, where the operator
  // still has the address in front of them.
  const connector = buildConnectorPreset(id, options);
  console.log(JSON.stringify([connector], null, 2));
}

/* ——— live surface: write policy and pending asks (F2.24) ——— */

type ModeRule = {
  scope: { level: "workspace" | "crew" | "agent"; ref?: string };
  route: string;
  mode: string;
  at: string;
};

/** What one seat's write routes resolve to, and the line they resolved through. */
type ModeEffective = {
  principal: string;
  managers: string[];
  routes: Array<{
    route: string;
    mode: string;
    source: { kind: "route-default" } | { kind: "rule"; scope: ModeRule["scope"]; route: string };
  }>;
};

type AskRow = {
  id: string;
  connector: string;
  route: string;
  method: string;
  path: string;
  principal: string;
  threadId: string;
  questionId: string;
  status: string;
  outcome?: string;
  createdAt: string;
  expiresAt: string;
  flowId?: string;
  runId?: string;
};

function orchUrl(args: string[]): string {
  return (flagValue(args, "--url") ?? process.env.ORCH_URL ?? "http://127.0.0.1:8788").replace(
    /\/$/,
    "",
  );
}

async function orchFetch<T>(args: string[], path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.ORCH_TOKEN?.trim();
  const res = await fetch(`${orchUrl(args)}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function scopeLabel(scope: ModeRule["scope"]): string {
  return scope.level === "workspace" ? "workspace" : `${scope.level} ${scope.ref}`;
}

/** `--scope workspace` / `--scope crew:0x…` / `--scope agent:0x…`. */
function parseScope(raw: string | undefined): ModeRule["scope"] {
  const value = (raw ?? "workspace").trim();
  if (value === "workspace") return { level: "workspace" };
  const colon = value.indexOf(":");
  const level = colon > 0 ? value.slice(0, colon) : value;
  const ref = colon > 0 ? value.slice(colon + 1) : "";
  if ((level !== "crew" && level !== "agent") || !ref) {
    throw new Error(
      `--scope expects workspace, crew:<address>, or agent:<address>, got "${value}"`,
    );
  }
  return { level, ref };
}

/** What decided a seat's mode, said the way an operator would ask about it. */
function sourceLabel(source: ModeEffective["routes"][number]["source"], seat: string): string {
  if (source.kind === "route-default") return "the route's own default";
  const scope = source.scope;
  if (scope.level === "workspace") return `workspace · ${source.route}`;
  const own = scope.ref?.trim().toLowerCase() === seat.trim().toLowerCase();
  return `${own ? "this seat" : `${scope.level} ${scope.ref}`} · ${source.route}`;
}

async function printModes(args: string[]): Promise<void> {
  // Same `--as` the UI's scope picker resolves through, and the same answer:
  // a rule set on a desk applies to everyone under it, so "what does this
  // worker run under" is not readable from the rule list alone.
  const seats = (flagValue(args, "--as") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const query = seats.length ? `?as=${seats.map(encodeURIComponent).join(",")}` : "";
  const body = await orchFetch<{
    rules: ModeRule[];
    modes: string[];
    effective?: ModeEffective[];
  }>(args, `/connectors/modes${query}`);
  console.log("Connector write policy\n");
  console.log("  auto  admitted by policy, called without asking");
  console.log("  ask   admitted by policy, a human confirms in-thread first");
  console.log("  deny  never called, the network is never reached\n");
  if (body.rules.length === 0) {
    console.log("No rules. Every write route runs at its declared default.");
  } else {
    for (const rule of body.rules) {
      console.log(`  ${rule.mode.padEnd(5)} ${rule.route.padEnd(34)} ${scopeLabel(rule.scope)}`);
    }
  }
  for (const seat of body.effective ?? []) {
    console.log(`\nEffective for ${seat.principal}`);
    console.log(
      `  reporting line: ${seat.managers.length ? seat.managers.join(" → ") : "(none read)"}`,
    );
    if (seat.routes.length === 0) {
      console.log("  No write routes are registered on this orchestrator.");
      continue;
    }
    for (const route of seat.routes) {
      console.log(
        `  ${route.mode.padEnd(5)} ${route.route.padEnd(34)} from ${sourceLabel(route.source, seat.principal)}`,
      );
    }
  }
  console.log("\nA rule only narrows: it cannot admit a write the policy stack refuses.");
  console.log("Set one:    lacrew connectors mode github.merge_pull_request ask");
  console.log("Clear one:  lacrew connectors mode github.merge_pull_request --clear");
  if (!seats.length) {
    console.log("One seat:   lacrew connectors modes --as 0x… (what that seat actually runs)");
  }
}

async function setMode(args: string[]): Promise<void> {
  const route = args[0];
  if (!route || route.startsWith("-")) {
    console.error(
      "usage: lacrew connectors mode <connector.route|connector.*> <auto|ask|deny> [--scope …]\n" +
        "       lacrew connectors mode <route> --clear [--scope …]",
    );
    process.exitCode = 1;
    return;
  }
  const rest = args.slice(1);
  const clear = rest.includes("--clear");
  const mode = clear ? null : rest.find((a) => !a.startsWith("-"));
  if (!clear && !mode) {
    console.error("a mode is required: auto | ask | deny (or --clear to remove the rule)");
    process.exitCode = 1;
    return;
  }
  const scope = parseScope(flagValue(rest, "--scope"));
  const body = await orchFetch<{ rule?: ModeRule; cleared?: boolean }>(rest, "/connectors/modes", {
    method: "PUT",
    body: JSON.stringify({ scope, route, mode }),
  });
  if (clear) {
    console.log(
      body.cleared
        ? `Cleared ${route} for ${scopeLabel(scope)} — it now runs at whatever it inherits.`
        : `No rule for ${route} at ${scopeLabel(scope)}.`,
    );
    return;
  }
  console.log(`${route} → ${body.rule?.mode} for ${scopeLabel(scope)}`);
}

async function printAsks(args: string[]): Promise<void> {
  const status = flagValue(args, "--status") ?? "pending";
  const body = await orchFetch<{ asks: AskRow[] }>(
    args,
    `/connectors/asks?status=${encodeURIComponent(status)}`,
  );
  if (body.asks.length === 0) {
    console.log(`No ${status} connector asks.`);
    return;
  }
  for (const ask of body.asks) {
    console.log(`${ask.id}  ${ask.connector}.${ask.route}  ${ask.status}`);
    console.log(`  ${ask.method} ${ask.path}`);
    console.log(
      `  as ${ask.principal || "—"}${ask.flowId ? ` · flow ${ask.flowId}` : ""}${ask.runId ? ` · run ${ask.runId}` : ""}`,
    );
    console.log(`  thread ${ask.threadId} · question ${ask.questionId} · expires ${ask.expiresAt}`);
    console.log(`  Answer:  lacrew connectors answer ${ask.id} yes|no --as <you>`);
    console.log("");
  }
}

async function answerAsk(args: string[]): Promise<void> {
  const [id, decision] = args;
  const rest = args.slice(2);
  const author = flagValue(rest, "--as");
  if (!id || (decision !== "yes" && decision !== "no") || !author) {
    console.error(
      "usage: lacrew connectors answer <askId> <yes|no> --as <human identifier>\n" +
        "  Only yes or no counts. Free text is stored as a claim and releases nothing.",
    );
    process.exitCode = 1;
    return;
  }
  const asks = await orchFetch<{ asks: AskRow[] }>(rest, "/connectors/asks?status=pending");
  const ask = asks.asks.find((a) => a.id === id);
  if (!ask) {
    console.error(`No pending ask "${id}". List them: lacrew connectors asks`);
    process.exitCode = 1;
    return;
  }
  await orchFetch(rest, "/messages", {
    method: "POST",
    body: JSON.stringify({
      thread: ask.threadId,
      author,
      authorKind: "human",
      kind: "answer",
      replyTo: ask.questionId,
      body: decision,
    }),
  });
  console.log(
    decision === "yes"
      ? `Confirmed ${ask.connector}.${ask.route}. The run picks up where it stopped and calls once.`
      : `Declined ${ask.connector}.${ask.route}. Nothing was called.`,
  );
  console.log(
    "This confirmed an external write only — it approved no spend and changed no policy.",
  );
}

export async function cmdConnectors(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  const rest = args.slice(1);
  try {
    switch (sub) {
      case "modes":
        await printModes(rest);
        return;
      case "mode":
        await setMode(rest);
        return;
      case "asks":
        await printAsks(rest);
        return;
      case "answer":
        await answerAsk(rest);
        return;
      case "list":
        printList();
        return;
      case "show": {
        const id = rest[0];
        if (!id) {
          console.error("usage: lacrew connectors show <id>");
          process.exitCode = 1;
          return;
        }
        printShow(id);
        return;
      }
      case "config": {
        const id = rest[0];
        if (!id) {
          console.error("usage: lacrew connectors config <id> [--policy-target <route>=0x…]");
          process.exitCode = 1;
          return;
        }
        printConfig(id, rest.slice(1));
        return;
      }
      case "help":
        console.log(`lacrew connectors — connector definitions, and the policy their writes run under

Offline (a preset is data):
  list                     Presets available
  show <id>                Routes, credential, and what must be bound
  config <id> [flags]      JSON for LACREW_CONNECTORS

Against a running orchestrator (ORCH_URL / --url, token via ORCH_TOKEN):
  modes                    Write-mode rules, and what auto/ask/deny mean
                           (--as 0x… resolves what one seat actually runs under)
  mode <route> <mode>      Narrow a write route (--scope, --clear)
  asks                     Writes waiting on a human (--status)
  answer <askId> yes|no    Confirm or refuse one, as a human seat (--as)

Flags for config:
  --auth <mode>                 Credential mode (see: connectors show <id>)
  --policy-target <name>=0x…    Admit a write (repeatable). The name is the
                                route's, or the authority several routes share
                                — see: connectors show <id>
  --branch <glob>               Branches a push route may write to (repeatable;
                                * within a segment, ** across). No default —
                                a push route will not register without one
  --deny-path <prefix>          Paths a push route refuses (repeatable;
                                replaces the default ${DEFAULT_DENY_PATH_PREFIXES.join(", ")})
  --omit <route>                Leave a route out (repeatable)
  --base-url <url>              Self-hosted instance (e.g. GitHub Enterprise);
                                required for a preset with no default host
  --token-env <NAME>            Read a token-mode credential from another env var
  --credential-header <name>    Send a token-mode credential in another header
  --id <name>                   Register under a different connector id

Flags for modes / mode / asks / answer:
  --scope workspace|crew:0x…|agent:0x…   Where a rule applies (default workspace)
  --clear                                Remove the rule instead of setting one
  --status <status>                      pending (default) | approved | declined | expired | consumed
  --as <identifier>                      The human seat answering; on "modes",
                                         the seat(s) to resolve (comma-separated)

Scopes name a node, not a label:
  crew:0x… is the address of the node a team hangs from, so a rule there covers
  every seat below it. A team's *name* is not an address — expand it to the
  members you mean and set the rule on each, rather than picking one at random.

Register it:
  export LACREW_CONNECTORS="$(lacrew connectors config github --policy-target merge_pull_request=0x…)"
  # or write the JSON to a file and point LACREW_CONNECTORS at the path

Modes narrow, never widen:
  ALLOW / ESCALATE / DENY is the chain's answer to "may this crew act at all".
  auto / ask / deny is the operator's answer to "and should a human see it first".
  A route with a policy target is checked against the stack whatever its mode says.
`);
        return;
      default:
        console.error(`Unknown subcommand "${sub}". Try: lacrew connectors help`);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
