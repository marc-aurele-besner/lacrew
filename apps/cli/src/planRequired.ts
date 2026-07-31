/**
 * `lacrew plan-required …` — no plan, no side effect (F2.31).
 *
 * The switch that makes a crew say what it is about to do before it does it.
 * Every subcommand talks to a running orchestrator, because a requirement is
 * per-deployment state and the evidence it reads — a `plan` message in a live
 * thread — only exists against one.
 *
 * What this does *not* do is approve anything. A plan is a claim: with the mode
 * on, a spend still meets the policy stack, still escalates, and still waits for
 * whoever approves it. Turning it on makes a crew legible; it never makes one
 * more powerful, which is why the command can only ever refuse work.
 */

import { PLAN_REQUIRED_MODES, type PlanRequiredMode, type PlanRequiredRecord } from "@lacrew/flows";

type Resolution = {
  mode: PlanRequiredMode;
  windowMs: number;
  minPlanChars: number;
  acceptUpstreamPlan: boolean;
  source: { kind: "default" } | { kind: "rule"; scope: { level: string; ref?: string } };
};

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

function numberFlag(args: string[], flag: string): number | undefined {
  const raw = flagValue(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${flag} must be a number (got "${raw}")`);
  return value;
}

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

/**
 * The scope a subcommand names. `--workspace` is explicit rather than implied by
 * omission: a rule that lands on every crew in the deployment should be typed
 * out, not defaulted into.
 */
export function scopeFrom(args: string[]): { level: "workspace" | "crew" | "agent"; ref?: string } {
  const crew = flagValue(args, "--crew");
  const agent = flagValue(args, "--agent");
  if (crew && agent) throw new Error("name one of --crew or --agent, not both");
  if (crew) return { level: "crew", ref: crew };
  if (agent) return { level: "agent", ref: agent };
  if (args.includes("--workspace")) return { level: "workspace" };
  throw new Error("name a scope: --workspace, --crew <address>, or --agent <address>");
}

export function scopeLabel(scope: { level: string; ref?: string }): string {
  return scope.level === "workspace" ? "workspace" : `${scope.level}:${scope.ref}`;
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)}m`;

function printRule(rule: PlanRequiredRecord): void {
  console.log(
    `  ${scopeLabel(rule.scope).padEnd(52)}  ${rule.mode.padEnd(13)}  window ${minutes(rule.windowMs)}` +
      `  min ${rule.minPlanChars} chars` +
      (rule.acceptUpstreamPlan ? "  upstream plans count" : ""),
  );
}

export async function cmdPlanRequired(args: string[]): Promise<void> {
  const [sub = "help", ...rest] = args;

  if (sub === "list" || sub === "show") {
    const as = flagValue(args, "--as") ?? (sub === "show" ? rest[0] : undefined);
    const body = await orchFetch<{
      rules: PlanRequiredRecord[];
      modes: PlanRequiredMode[];
      effective?: Resolution;
    }>(args, `/plan-required${as ? `?as=${encodeURIComponent(as)}` : ""}`);

    if (body.rules.length === 0) {
      console.log("No scope requires a plan on this orchestrator — every crew acts unannounced.");
      console.log("Turn it on:  lacrew plan-required set --workspace --mode side_effects");
    } else {
      console.log("Plan-required rules\n");
      for (const rule of body.rules) printRule(rule);
    }
    if (body.effective) {
      const source =
        body.effective.source.kind === "rule"
          ? scopeLabel(body.effective.source.scope)
          : "nothing configured";
      console.log(
        `\n${as} runs under ${body.effective.mode} (from ${source}), ` +
          `window ${minutes(body.effective.windowMs)}` +
          (body.effective.acceptUpstreamPlan ? ", upstream plans count" : ""),
      );
    }
    console.log(`\nmodes: ${body.modes.join(" | ")}`);
    return;
  }

  if (sub === "set") {
    const scope = scopeFrom(args);
    const mode = flagValue(args, "--mode");
    if (!mode || !PLAN_REQUIRED_MODES.includes(mode as PlanRequiredMode)) {
      throw new Error(`--mode must be ${PLAN_REQUIRED_MODES.join(" | ")}`);
    }
    const windowMin = numberFlag(args, "--window-min");
    const body = await orchFetch<{ rule: PlanRequiredRecord }>(args, "/plan-required", {
      method: "PUT",
      body: JSON.stringify({
        scope,
        mode,
        ...(windowMin !== undefined ? { windowMs: windowMin * 60_000 } : {}),
        ...(numberFlag(args, "--min-chars") !== undefined
          ? { minPlanChars: numberFlag(args, "--min-chars") }
          : {}),
        ...(args.includes("--accept-upstream") ? { acceptUpstreamPlan: true } : {}),
      }),
    });
    console.log(`${scopeLabel(scope)} → ${body.rule.mode}`);
    printRule(body.rule);
    if (body.rule.mode === "off") {
      console.log("Pinned off: a broader rule added later will not reach this scope.");
    } else {
      console.log(
        "A plan is a claim, not an approval — spends still meet the policy stack and still escalate.",
      );
    }
    return;
  }

  if (sub === "clear") {
    const scope = scopeFrom(args);
    const body = await orchFetch<{ cleared: boolean }>(args, "/plan-required", {
      method: "PUT",
      body: JSON.stringify({ scope, mode: null }),
    });
    console.log(
      body.cleared
        ? `Cleared ${scopeLabel(scope)}; it now inherits whatever a broader rule says.`
        : `No rule at ${scopeLabel(scope)}.`,
    );
    return;
  }

  console.log(`lacrew plan-required — no plan, no side effect (F2.31)

  list [--as 0x…]                    Rules in force; --as also resolves one seat
  set --workspace|--crew 0x…|--agent 0x…
      --mode off|spends_only|side_effects
      [--window-min 30]              How long a plan stays current
      [--min-chars 24]               Below this, a plan is not a plan
      [--accept-upstream]            A delegating manager's plan counts too
  clear --workspace|--crew 0x…|--agent 0x…

Modes
  off            What crews did before this existed.
  spends_only    Onchain proposes need a plan. The money path, nothing else.
  side_effects   Spends plus connector writes, external MCP writes, and the
                 org / budget / governance mutators.

A qualifying plan is a \`plan\` message from the acting agent, in a thread it
speaks in, inside the window — or one the same run already posted. It approves
nothing: this is about being legible first, not about being allowed.

Not the same as a blocking human gate (F2.27), which stops a run until a person
decides. This mode asks nobody.

Orchestrator: --url or ORCH_URL (default http://127.0.0.1:8788)`);
}
