/**
 * `lacrew budget …` — a crew's inference cost budget, from the terminal (F2.28).
 *
 * This is the *other* budget. An onchain budget is a streamed allowance and a
 * policy stack, and it bounds what a crew may pay counterparties; nothing in it
 * sees a token of inference. This one bounds what a crew's model calls may cost
 * the operator, and it moves no funds — raising it lets a stopped crew think
 * again, never spend more onchain.
 *
 * Every subcommand talks to a running orchestrator, because the counters are
 * only meaningful against one: what a crew has spent this period is a fact
 * about that deployment's ledger, not about a config file.
 */

import { INFERENCE_BUDGET_WARN_RATIO, type InferenceBudget } from "@lacrew/flows";

type BudgetView = {
  scopeKey: string;
  budget: InferenceBudget;
  period: { key: string; startsAt: string; endsAt: string };
  status: {
    state: "ok" | "warning" | "exceeded";
    ratio: number;
    worst: string | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      usdMicros: number;
      calls: number;
      unpricedCalls: number;
    };
    remaining: { usd?: number; inputTokens?: number; outputTokens?: number };
    usdIncomplete: boolean;
  };
};

type UsageEvent = {
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  usdMicros: number | null;
  priceSource: string;
  tokensEstimated: boolean;
  runId?: string;
  at: string;
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

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

/** `72%` — the number the guard compares, not a re-derived one. */
const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

function printBudget(view: BudgetView): void {
  const { budget, status } = view;
  console.log(`${view.scopeKey}  ${budget.enabled ? budget.policy : "off"}  ${status.state}`);
  console.log(`  Period      ${view.period.key}  (rolls ${view.period.endsAt})`);
  const limits: string[] = [];
  if (budget.limits.maxUsd !== undefined) limits.push(`$${budget.limits.maxUsd}`);
  if (budget.limits.maxInputTokens !== undefined) {
    limits.push(`${budget.limits.maxInputTokens} in`);
  }
  if (budget.limits.maxOutputTokens !== undefined) {
    limits.push(`${budget.limits.maxOutputTokens} out`);
  }
  console.log(`  Limits      ${limits.join(" · ") || "none"}`);
  console.log(
    `  Used        ${usd(status.usage.usdMicros)} · ` +
      `${status.usage.inputTokens} in · ${status.usage.outputTokens} out · ` +
      `${status.usage.calls} call(s)  → ${pct(status.ratio)}` +
      (status.worst ? ` of ${status.worst}` : ""),
  );
  if (status.usdIncomplete) {
    // Said plainly rather than rendered as a number: a dollar figure that
    // silently omits calls is worse than one labelled incomplete.
    console.log(
      `  Note        ${status.usage.unpricedCalls} call(s) had no known price — the $ figure is a floor`,
    );
  }
  if (budget.cheapModel)
    console.log(
      `  Past ${pct(INFERENCE_BUDGET_WARN_RATIO)}       fall back to ${budget.cheapModel}`,
    );
  if (budget.policy === "hard") {
    console.log(
      `  On breach   refuse model calls${budget.pauseHeartbeatOnBreach ? " and hold the heartbeat" : ""}`,
    );
  } else {
    console.log("  On breach   warn only — nothing is blocked");
  }
}

export async function cmdBudget(args: string[]): Promise<void> {
  const [sub = "help", ...rest] = args;
  const crew = flagValue(args, "--crew") ?? (rest[0]?.startsWith("-") ? undefined : rest[0]);
  const agent = flagValue(args, "--agent");
  const subject = { crewId: crew, ...(agent ? { agentId: agent } : {}) };

  if (sub === "list") {
    const body = await orchFetch<{ budgets: BudgetView[]; store: string }>(args, "/budgets");
    if (body.budgets.length === 0) {
      console.log("No crew has an inference budget on this orchestrator.");
      console.log("Set one:  lacrew budget set --crew trading --usd 200 --hard --enable");
      return;
    }
    for (const view of body.budgets) {
      printBudget(view);
      console.log("");
    }
    console.log(`store ${body.store} · warn at ${pct(INFERENCE_BUDGET_WARN_RATIO)}`);
    return;
  }

  if (sub === "show") {
    if (!crew) throw new Error("lacrew budget show --crew <id> [--agent 0x…]");
    const query = `?crewId=${encodeURIComponent(crew)}${agent ? `&agentId=${encodeURIComponent(agent)}` : ""}`;
    const body = await orchFetch<{ budget: BudgetView }>(args, `/budgets/one${query}`);
    printBudget(body.budget);
    return;
  }

  if (sub === "set") {
    if (!crew)
      throw new Error("lacrew budget set --crew <id> [--usd 200] [--in-tokens n] [--out-tokens n]");
    const budget = {
      crewId: crew,
      ...(agent ? { agentId: agent } : {}),
      limits: {
        ...(numberFlag(args, "--usd") !== undefined ? { maxUsd: numberFlag(args, "--usd") } : {}),
        ...(numberFlag(args, "--in-tokens") !== undefined
          ? { maxInputTokens: numberFlag(args, "--in-tokens") }
          : {}),
        ...(numberFlag(args, "--out-tokens") !== undefined
          ? { maxOutputTokens: numberFlag(args, "--out-tokens") }
          : {}),
      },
      ...(flagValue(args, "--period") ? { period: flagValue(args, "--period") } : {}),
      ...(numberFlag(args, "--window-days") !== undefined
        ? { windowDays: numberFlag(args, "--window-days") }
        : {}),
      ...(flagValue(args, "--anchor") ? { anchorAt: flagValue(args, "--anchor") } : {}),
      policy: args.includes("--hard") ? "hard" : "soft",
      ...(flagValue(args, "--cheap-model") ? { cheapModel: flagValue(args, "--cheap-model") } : {}),
      ...(args.includes("--keep-heartbeat") ? { pauseHeartbeatOnBreach: false } : {}),
      enabled: args.includes("--enable"),
    };
    const body = await orchFetch<{ budget: InferenceBudget }>(args, "/budgets", {
      method: "POST",
      body: JSON.stringify({ budget }),
    });
    console.log(
      `Saved ${body.budget.crewId}${body.budget.agentId ? `/${body.budget.agentId}` : ""}.`,
    );
    if (!body.budget.enabled) {
      console.log(`Stored but off. Turn it on:  lacrew budget on --crew ${body.budget.crewId}`);
    } else if (body.budget.policy === "soft") {
      console.log("Soft: this warns and blocks nothing. Add --hard to refuse calls at the line.");
    }
    return;
  }

  if (sub === "on" || sub === "off") {
    if (!crew) throw new Error(`lacrew budget ${sub} --crew <id> [--agent 0x…]`);
    const body = await orchFetch<{ budget: InferenceBudget }>(args, "/budgets/enabled", {
      method: "POST",
      body: JSON.stringify({ ...subject, enabled: sub === "on" }),
    });
    console.log(`${body.budget.crewId} inference budget is ${body.budget.enabled ? "on" : "off"}.`);
    return;
  }

  if (sub === "remove") {
    if (!crew) throw new Error("lacrew budget remove --crew <id> [--agent 0x…]");
    const body = await orchFetch<{ removed: boolean }>(args, "/budgets/delete", {
      method: "POST",
      body: JSON.stringify(subject),
    });
    console.log(body.removed ? `Removed the budget for ${crew}.` : `No budget for ${crew}.`);
    return;
  }

  if (sub === "usage") {
    if (!crew) throw new Error("lacrew budget usage --crew <id> [--agent 0x…] [--limit 50]");
    const limit = flagValue(args, "--limit") ?? "50";
    const query =
      `?crewId=${encodeURIComponent(crew)}` +
      (agent ? `&agentId=${encodeURIComponent(agent)}` : "") +
      `&limit=${encodeURIComponent(limit)}`;
    const body = await orchFetch<{ budget: BudgetView | null; events: UsageEvent[] }>(
      args,
      `/budgets/usage${query}`,
    );
    if (body.budget) {
      printBudget(body.budget);
      console.log("");
    }
    if (body.events.length === 0) {
      console.log("No metered call in this period.");
      return;
    }
    for (const event of body.events) {
      const cost = event.usdMicros === null ? "$ unknown" : usd(event.usdMicros);
      const marks = [
        event.priceSource === "table" ? "est." : "",
        event.tokensEstimated ? "tokens approx." : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(
        `${event.at}  ${cost.padStart(11)}  ${String(event.inputTokens).padStart(7)} in  ` +
          `${String(event.outputTokens).padStart(7)} out  ${event.model}` +
          (event.runId ? `  [${event.runId}]` : "") +
          (marks ? `  (${marks})` : ""),
      );
    }
    return;
  }

  console.log(`lacrew budget — a crew's inference cost budget (F2.28)

  list                               Every budget on this orchestrator
  show --crew <id> [--agent 0x…]     One budget with its live standing
  set --crew <id> [--agent 0x…]
      [--usd 200]                    Dollars for the period
      [--in-tokens n] [--out-tokens n]
      [--period calendar_month|epoch|window]
      [--window-days 30] [--anchor <ISO>]
      [--hard]                       Refuse calls at the line (default: warn)
      [--cheap-model <id>]           Fall back to this past ${pct(INFERENCE_BUDGET_WARN_RATIO)}
      [--keep-heartbeat]             Do not hold the heartbeat on a hard breach
      [--enable]                     Turn it on as it is saved
  on|off --crew <id>                 Enable / disable
  usage --crew <id> [--limit 50]     The calls behind the number
  remove --crew <id>                 Drop the budget

This is not an onchain budget. It bounds what a crew's model calls cost the
operator; it moves no funds, is not a PolicyModule, and a crew that has burned
it can still propose a spend — that spend is judged by its policy stack exactly
as before. USD is best effort: a call the provider did not price and the local
table does not know is counted as unpriced, never as free.

Env: ORCH_URL (or --url), ORCH_TOKEN, LACREW_MODEL_PRICES`);
}
