/**
 * `lacrew connectors …` — the connector definitions that ship, and the config
 * an operator pastes into `LACREW_CONNECTORS` (F2.13).
 *
 * `lacrew crews show github-experts` names the routes the crew calls and says
 * to register them first. This is where they come from. Fully offline: a preset
 * is data, and `config` prints JSON rather than writing anywhere, so what the
 * operator admits stays their decision.
 *
 * `config` refuses to emit a write route with no policy target instead of
 * printing something that would fail at boot — the error names the address that
 * is missing and what it stands for.
 */

import {
  buildConnectorPreset,
  connectorPresets,
  getConnectorPreset,
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
  const gate = route.policyTarget?.required ? "  ⚠ needs a policy target" : "";
  return `  ${route.effect === "write" ? "write" : "read "}  ${preset.id}.${route.name}  ${route.method} ${route.path}${gate}`;
}

function printList(): void {
  console.log("Connector presets\n");
  for (const preset of connectorPresets) {
    console.log(`  ${preset.id}  —  ${preset.title}`);
    console.log(`     ${preset.summary}`);
    console.log(`     auth: ${preset.auth.map((a) => a.mode).join(" | ")} (default ${preset.auth[0]!.mode})`);
    console.log(
      `     routes: ${preset.routes.length} (${preset.routes.filter((r) => r.effect === "write").length} write)`,
    );
    console.log("");
  }
  console.log("Detail:  lacrew connectors show <id>");
  console.log("Config:  lacrew connectors config <id> --policy-target <route>=0x…");
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
  console.log(`\nBase URL   ${preset.baseUrl}`);

  // Modes are listed best-posture first, and the default is the first, so an
  // operator who reads top-down lands on the one they should be using.
  console.log("\nCredential modes");
  preset.auth.forEach((auth, i) => {
    const envVars =
      auth.mode === "github-app"
        ? [auth.appIdEnv, auth.privateKeyEnv, auth.installationIdEnv]
        : [auth.env];
    console.log(`  ${auth.mode}${i === 0 ? "  (default)" : ""}  —  ${auth.label}`);
    console.log(`      env: ${envVars.join(", ")}`);
    console.log(`      ${auth.note}`);
  });

  console.log("\nRoutes");
  for (const route of preset.routes) {
    console.log(routeLine(preset, route.name));
    if (route.description) console.log(`         ${route.description}`);
    if (route.params?.length) console.log(`         args: ${route.params.join(", ")}`);
    if (route.policyTarget) console.log(`         target: ${route.policyTarget.note}`);
  }

  const gated = preset.routes.filter((r) => r.policyTarget?.required);
  if (gated.length > 0) {
    console.log("\nBind before registering");
    for (const route of gated) {
      console.log(`  --policy-target ${route.name}=0x…`);
    }
    console.log("  Or leave the write out entirely:");
    console.log(`  --omit ${gated.map((r) => r.name).join(" --omit ")}`);
  }

  console.log(
    `\nEmit it:  lacrew connectors config ${preset.id}${gated.map((r) => ` --policy-target ${r.name}=0x…`).join("")}`,
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
  const authMode = flagValue(args, "--auth") as ConnectorPresetAuthMode | undefined;
  const options: ConnectorPresetOptions = {
    ...(authMode ? { authMode } : {}),
    ...(flagValue(args, "--base-url") ? { baseUrl: flagValue(args, "--base-url") } : {}),
    ...(flagValue(args, "--token-env") ? { tokenEnv: flagValue(args, "--token-env") } : {}),
    ...(flagValue(args, "--id") ? { id: flagValue(args, "--id") } : {}),
    ...(Object.keys(policyTargets).length > 0 ? { policyTargets } : {}),
    ...(omitRoutes.length > 0 ? { omitRoutes } : {}),
  };
  // Throws rather than emits when a write is unbound: config that would stop
  // the orchestrator at boot is worse than an error here, where the operator
  // still has the address in front of them.
  const connector = buildConnectorPreset(id, options);
  console.log(JSON.stringify([connector], null, 2));
}

export function cmdConnectors(args: string[]): void {
  const sub = args[0] ?? "list";
  const rest = args.slice(1);
  try {
    switch (sub) {
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
        console.log(`lacrew connectors — connector definitions that ship

  list                     Presets available
  show <id>                Routes, credential, and what must be bound
  config <id> [flags]      JSON for LACREW_CONNECTORS

Flags for config:
  --auth <mode>                 Credential mode (see: connectors show <id>)
  --policy-target <route>=0x…   Admit a write route (repeatable)
  --omit <route>                Leave a route out (repeatable)
  --base-url <url>              Self-hosted instance (e.g. GitHub Enterprise)
  --token-env <NAME>            Read a token-mode credential from another env var
  --id <name>                   Register under a different connector id

Register it:
  export LACREW_CONNECTORS="$(lacrew connectors config github --policy-target merge_pull_request=0x…)"
  # or write the JSON to a file and point LACREW_CONNECTORS at the path
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
