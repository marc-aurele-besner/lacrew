/**
 * `lacrew dual-control …` — a second seat agrees, or it does not happen (F2.32).
 *
 * The switch that puts four eyes in front of a merge or a spend. Every
 * subcommand talks to a running orchestrator, because the rules are
 * per-deployment state and the reviews they open live in a live conversation.
 *
 * What this does *not* do is hand anyone authority. A concurrence releases a
 * step the acting seat was already permitted to take: the spend behind it still
 * meets the policy stack, still escalates, and still waits for whoever approves
 * it. And two agents on one orchestrator are review, not trust — whatever
 * compromised the actor may well reach the reviewer, so treasury changes that
 * matter still need human governance.
 */

import {
  DUAL_CONTROL_MODES,
  DUAL_CONTROL_REVIEWERS,
  formatReviewer,
  parseReviewer,
  type DualControlMode,
  type DualControlRecord,
} from "@lacrew/flows";

type Resolution = {
  mode: DualControlMode;
  reviewer: Parameters<typeof formatReviewer>[0];
  threshold: { minSpend: string; connectorWrites: boolean; orgMutators: boolean };
  timeoutMs: number;
  source: { kind: "default" } | { kind: "rule"; scope: { level: string; ref?: string } };
};

type ReviewerTargetView = {
  via: string;
  accounts: string[];
  human: boolean;
  escalated: boolean;
};

type ReviewView = {
  id: string;
  tool: string;
  effect: string;
  value?: string;
  actor: string;
  reviewer: string;
  reviewers: string[];
  human: boolean;
  escalated: boolean;
  status: string;
  decidedBy?: string;
  runId?: string;
  createdAt: string;
  expiresAt: string;
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
 * The scope a subcommand names. `--workspace` is explicit rather than implied
 * by omission: a rule that lands on every crew in the deployment should be
 * typed out, not defaulted into.
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

/** What a rule covers, in the words an operator set it with. */
export function coverage(rule: {
  mode: DualControlMode;
  threshold: { minSpend: string; connectorWrites: boolean; orgMutators: boolean };
}): string {
  if (rule.mode === "off") return "nothing";
  const parts: string[] = [];
  if (rule.mode === "spends_and_writes") {
    parts.push(rule.threshold.minSpend === "0" ? "every spend" : `spends ≥ ${rule.threshold.minSpend}`);
  }
  if (rule.threshold.connectorWrites) parts.push("connector + MCP writes");
  if (rule.threshold.orgMutators) parts.push("org/budget/governance");
  return parts.length > 0 ? parts.join(", ") : "nothing";
}

function printRule(rule: DualControlRecord): void {
  console.log(
    `  ${scopeLabel(rule.scope).padEnd(52)}  ${rule.mode.padEnd(18)}  ` +
      `reviewer ${formatReviewer(rule.reviewer).padEnd(20)}  ${minutes(rule.timeoutMs)}`,
  );
  console.log(`  ${" ".repeat(52)}  covers: ${coverage(rule)}`);
}

export async function cmdDualControl(args: string[]): Promise<void> {
  const [sub = "help", ...rest] = args;

  if (sub === "list" || sub === "show") {
    const as = flagValue(args, "--as") ?? (sub === "show" ? rest[0] : undefined);
    const body = await orchFetch<{
      rules: DualControlRecord[];
      modes: DualControlMode[];
      reviewers: string[];
      effective?: Resolution;
      reviewer?: ReviewerTargetView | null;
    }>(args, `/dual-control${as ? `?as=${encodeURIComponent(as)}` : ""}`);

    if (body.rules.length === 0) {
      console.log("No scope needs a second seat on this orchestrator — every crew acts alone.");
      console.log("Turn it on:  lacrew dual-control set --workspace --mode risky_writes");
    } else {
      console.log("Dual-control rules\n");
      for (const rule of body.rules) printRule(rule);
    }
    if (body.effective) {
      const source =
        body.effective.source.kind === "rule"
          ? scopeLabel(body.effective.source.scope)
          : "nothing configured";
      console.log(
        `\n${as} runs under ${body.effective.mode} (from ${source}), ` +
          `reviewer ${formatReviewer(body.effective.reviewer)}, timeout ${minutes(body.effective.timeoutMs)}`,
      );
      if (body.reviewer) {
        const who = body.reviewer.human
          ? body.reviewer.accounts.length > 0
            ? `a human (${body.reviewer.accounts.join(", ")})`
            : "a human"
          : body.reviewer.accounts.join(" or ");
        console.log(
          `Right now that resolves to: ${who}` +
            (body.reviewer.escalated
              ? " — escalated, because the configured reviewer is unavailable"
              : ""),
        );
      }
    }
    console.log(`\nmodes: ${body.modes.join(" | ")}`);
    console.log(`reviewers: ${body.reviewers.join(" | ")}`);
    return;
  }

  if (sub === "reviews") {
    const status = flagValue(args, "--status") ?? "pending";
    const body = await orchFetch<{ reviews: ReviewView[]; answerVia: string }>(
      args,
      `/dual-control/reviews?status=${encodeURIComponent(status)}`,
    );
    if (body.reviews.length === 0) {
      console.log(`No ${status} reviews.`);
      return;
    }
    console.log(`${status} reviews\n`);
    for (const review of body.reviews) {
      const who = review.human ? "a human" : review.reviewers.join(" or ");
      console.log(
        `  ${review.id}  ${review.tool}${review.value ? ` (${review.value})` : ""}\n` +
          `    ${review.actor} → ${who}${review.escalated ? " (escalated)" : ""}` +
          `${review.runId ? `  run ${review.runId}` : ""}  expires ${review.expiresAt}` +
          `${review.decidedBy ? `  decided by ${review.decidedBy}` : ""}`,
      );
    }
    console.log(`\n${body.answerVia}`);
    return;
  }

  if (sub === "set") {
    const scope = scopeFrom(args);
    const mode = flagValue(args, "--mode");
    if (!mode || !DUAL_CONTROL_MODES.includes(mode as DualControlMode)) {
      throw new Error(`--mode must be ${DUAL_CONTROL_MODES.join(" | ")}`);
    }
    const reviewerRaw = flagValue(args, "--reviewer");
    if (reviewerRaw && !parseReviewer(reviewerRaw)) {
      throw new Error(`--reviewer must be ${DUAL_CONTROL_REVIEWERS.join(" | ")}`);
    }
    const timeoutMin = numberFlag(args, "--timeout-min");
    const body = await orchFetch<{ rule: DualControlRecord }>(args, "/dual-control", {
      method: "PUT",
      body: JSON.stringify({
        scope,
        mode,
        ...(reviewerRaw ? { reviewer: reviewerRaw } : {}),
        ...(timeoutMin !== undefined ? { timeoutMs: timeoutMin * 60_000 } : {}),
        ...(flagValue(args, "--min-spend") ? { minSpend: flagValue(args, "--min-spend") } : {}),
        ...(args.includes("--no-connector-writes") ? { connectorWrites: false } : {}),
        ...(args.includes("--no-org-mutators") ? { orgMutators: false } : {}),
      }),
    });
    console.log(`${scopeLabel(scope)} → ${body.rule.mode}`);
    printRule(body.rule);
    if (body.rule.mode === "off") {
      console.log("Pinned off: a broader rule added later will not reach this scope.");
    } else {
      console.log(
        "A concurrence releases a paused step — it approves no spend and signs nothing onchain.",
      );
      if (formatReviewer(body.rule.reviewer) !== "role:human") {
        console.log(
          "Reviewer is an agent: that is review, not trust. High-tier treasury changes still need people.",
        );
      }
    }
    return;
  }

  if (sub === "clear") {
    const scope = scopeFrom(args);
    const body = await orchFetch<{ cleared: boolean }>(args, "/dual-control", {
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

  console.log(`lacrew dual-control — a second seat agrees, or it does not happen (F2.32)

  list [--as 0x…]                    Rules in force; --as also resolves one seat
                                     and says who would actually be asked
  reviews [--status pending]         Effects waiting on somebody
  set --workspace|--crew 0x…|--agent 0x…
      --mode off|risky_writes|spends_and_writes
      [--reviewer manager|seat:0x…|role:human|any_peer_in_crew]
      [--min-spend 1000000]          Base units; spends below this are not reviewed
      [--no-connector-writes]        Leave connector + MCP writes unreviewed
      [--no-org-mutators]            Leave org/budget/governance unreviewed
      [--timeout-min 1440]           After this, the effect fails closed
  clear --workspace|--crew 0x…|--agent 0x…

Modes
  off                What crews did before this existed.
  risky_writes       Connector and external-MCP writes, plus the org / budget /
                     governance mutators. A merge, a publish, a reparent.
  spends_and_writes  Those, plus onchain proposes at or above --min-spend.

Answering happens in the thread: reply \`concur\` or \`reject\` to the question,
as a seat other than the one acting. The actor can never answer its own review,
and a person may always answer in place of an agent reviewer.

Not the same as a human gate (F2.27), which stops a run where the *flow author*
put a stop. This stops it wherever the *operator's policy* matches an effect.
Not the same as plan-required (F2.31): that one asks the agent to speak, this
one asks somebody else to agree.

Orchestrator: --url or ORCH_URL (default http://127.0.0.1:8788)`);
}
