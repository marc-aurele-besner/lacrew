/**
 * `lacrew pnl …` — what a crew cost over a period, from the terminal (F2.33).
 *
 * One report over three meters an operator otherwise reads in three places:
 * what left the treasury onchain, what the crew's model calls cost, and what
 * its connectors did. The two budgets stay separate on the page for the reason
 * they are separate in the system — an onchain allowance and an inference cap
 * bound different things, and adding them would produce a number that means
 * nothing.
 *
 * Reads a running orchestrator, like `lacrew budget`: a period's figures are a
 * fact about a deployment's ledger, not about a config file.
 */

import type { PnlReport } from "@lacrew/flows";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-"))
    return args[i + 1];
  return undefined;
}

function orchUrl(args: string[]): string {
  return (
    flagValue(args, "--url") ??
    process.env.ORCH_URL ??
    "http://127.0.0.1:8788"
  ).replace(/\/$/, "");
}

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

/** Base units → the asset's own units. USDC's 6 decimals unless told otherwise. */
function amount(base: string, decimals = 6): string {
  let n = 0n;
  try {
    n = BigInt(base);
  } catch {
    return base;
  }
  const unit = 10n ** BigInt(decimals);
  const whole = (n / unit).toString();
  const frac = (n % unit).toString().padStart(decimals, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

function printReport(report: PnlReport): void {
  const who =
    report.scope.kind === "agent" ? report.scope.agentId! : report.scope.crewId;
  console.log(
    `${who}  ${report.period.key}  (${report.period.from} → ${report.period.to} UTC)`,
  );
  console.log(`  asOf        ${report.asOf}`);

  for (const asset of report.totals.onchain.assets) {
    console.log(
      `  Onchain     ${amount(asset.spent)} ${asset.asset} spent · ` +
        `${amount(asset.pending)} pending · ${amount(asset.granted)} granted` +
        (asset.marketplace !== "0"
          ? ` · ${amount(asset.marketplace)} marketplace`
          : ""),
    );
  }
  if (report.totals.onchain.assets.length === 0) {
    console.log(`  Onchain     nothing settled in this window`);
  }

  const inf = report.totals.inference;
  // Every call unpriced means the $ figure is not a floor, it is nothing —
  // printing $0.0000 there would read as free.
  const inferenceCost = !report.sources.inference.available
    ? "not measured"
    : inf.calls > 0 && inf.unpricedCalls === inf.calls
      ? "price unknown"
      : usd(inf.usdMicros);
  console.log(
    `  Inference   ${inferenceCost} · ` +
      `${inf.calls} call(s) · ${inf.inputTokens} in · ${inf.outputTokens} out` +
      (inf.unpricedCalls > 0
        ? `  (${inf.unpricedCalls} unpriced — this is a floor)`
        : ""),
  );

  const con = report.totals.connectors;
  console.log(
    `  Connectors  ${con.calls} call(s) · ${con.writes} write · ${con.reads} read · ` +
      `${con.failed} failed · ` +
      (con.usdMicros === null
        ? "price unknown"
        : `${usd(con.usdMicros)} priced`),
  );

  if (report.headroom.inference) {
    const h = report.headroom.inference;
    console.log(
      `  Budget      ${h.policy} · ${h.status.state} · ` +
        (h.remainingUsdMicros === null
          ? "no $ limit"
          : `${usd(h.remainingUsdMicros)} left of ${usd(h.limitUsdMicros ?? 0)}`) +
        ` (period ${h.periodKey})`,
    );
  }
  for (const row of report.headroom.onchain) {
    console.log(
      `  Allowance   ${row.node}  ${row.remaining === null ? "unread" : `${amount(row.remaining)} ${row.asset} left`}` +
        (row.capPerCall ? ` · cap ${amount(row.capPerCall)}/call` : ""),
    );
  }

  if (report.seats.length > 0) {
    console.log("");
    console.log(
      "  seat                                        spent      model $   calls",
    );
    for (const seat of report.seats) {
      const spent = seat.onchain.assets[0]?.spent ?? "0";
      console.log(
        `  ${(seat.label ? `${seat.label} ` : "") + seat.agentId}`.padEnd(46) +
          amount(spent).padStart(10) +
          usd(seat.inference.usdMicros).padStart(12) +
          String(seat.connectors.calls).padStart(8),
      );
    }
  }

  console.log("");
  console.log(
    `  sources: onchain ${sourceLabel(report.sources.onchain)} · ` +
      `inference ${sourceLabel(report.sources.inference)} · ` +
      `connectors ${sourceLabel(report.sources.connectors)}`,
  );
  for (const note of report.notes) console.log(`  note: ${note}`);
}

function sourceLabel(source: PnlReport["sources"]["onchain"]): string {
  if (!source.available) return "unavailable";
  return `${source.store}${source.complete ? "" : " (partial)"}`;
}

export async function cmdPnl(args: string[]): Promise<void> {
  const [first = "", ...rest] = args;
  if (first === "help" || first === "--help" || (!first && rest.length === 0)) {
    console.log(`lacrew pnl — what a crew cost over a period (F2.33)

  pnl --crew <id> [--agent 0x…]
      [--period calendar_month|calendar_week|epoch]
      [--from <ISO> --to <ISO>]      An explicit window wins over --period
      [--epoch-seconds n]            Length of an epoch period
      [--epoch-anchor <ISO>]         Where epochs are counted from
      [--csv]                        The accountant's flat export
      [--json]                       The report as served
      [--url http://127.0.0.1:8788]

Reporting only: this approves nothing, moves nothing, and changes no limit.
An onchain allowance and an inference budget bound different things; both are
shown, and neither is added to the other.`);
    return;
  }

  const crew =
    flagValue(args, "--crew") ?? (first.startsWith("-") ? undefined : first);
  if (!crew)
    throw new Error(
      "lacrew pnl --crew <id> [--agent 0x…] [--period calendar_month]",
    );

  const query = new URLSearchParams({ crewId: crew });
  const pass = [
    ["--agent", "agentId"],
    ["--period", "period"],
    ["--from", "from"],
    ["--to", "to"],
    ["--epoch-seconds", "epochSeconds"],
    ["--epoch-anchor", "epochAnchorAt"],
  ] as const;
  for (const [flag, param] of pass) {
    const value = flagValue(args, flag);
    if (value) query.set(param, value);
  }
  if (args.includes("--csv")) query.set("format", "csv");

  const token = process.env.ORCH_TOKEN?.trim();
  const res = await fetch(`${orchUrl(args)}/pnl?${query.toString()}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (args.includes("--csv")) {
    const text = await res.text();
    if (!res.ok) throw new Error(text || `${res.status} ${res.statusText}`);
    console.log(text);
    return;
  }
  const body = (await res.json().catch(() => ({}))) as PnlReport & {
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  printReport(body);
}
