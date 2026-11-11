/**
 * Gas the CLI pays, reported to a running orchestrator.
 *
 * The orchestrator records what its own transactions cost. The CLI's are sent
 * by another process with another client, so they reach that ledger only when
 * reported: `POST /usage/gas` takes a hash, reads the receipt off its own
 * chain, and refuses anything not sent to its deployment. Nothing here states
 * a fee — the orchestrator never takes one on a caller's word.
 *
 * Opt-in, because most CLI use is against a chain with no orchestrator
 * running, and a command must not fail or stall for want of one:
 *
 * - `--report-gas` (or `LACREW_REPORT_GAS=1`) on a command that writes reports
 *   each transaction the command sends.
 * - `lacrew gas report <hash>…` reports transactions after the fact, and
 *   `lacrew gas report --deploy` the ones `lacrew deploy` broadcast.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flagValue, hasFlag } from "./args.js";
import { OrchRefusal, orchFetch } from "./orch.js";

/** Who the report says paid. A paymaster's sponsorship cannot be shown by a hash. */
export const REPORTABLE_PAYERS = ["orchestrator", "agent", "approver"] as const;
export type ReportablePayer = (typeof REPORTABLE_PAYERS)[number];

export type GasReport = {
  txHash: string;
  kind: string;
  payer?: ReportablePayer;
  agent?: string;
};

export type GasReportResult =
  | { txHash: string; recorded: true; feeWei: string | null; status: string; payer: string }
  | { txHash: string; recorded: false; reason: string };

/** Whether this invocation asked for its own writes to be reported. */
export function gasReportingEnabled(args: string[]): boolean {
  const env = process.env.LACREW_REPORT_GAS?.trim().toLowerCase();
  return hasFlag(args, "--report-gas") || env === "1" || env === "true";
}

/** The payer a report names: `--gas-payer`, then `LACREW_GAS_PAYER`, else the orchestrator's default. */
export function gasPayerFrom(args: string[]): ReportablePayer | undefined {
  const raw = flagValue(args, "--gas-payer") ?? process.env.LACREW_GAS_PAYER?.trim();
  if (!raw) return undefined;
  if (!(REPORTABLE_PAYERS as readonly string[]).includes(raw)) {
    throw new Error(`Unknown gas payer "${raw}" (supported: ${REPORTABLE_PAYERS.join(", ")}).`);
  }
  return raw as ReportablePayer;
}

/**
 * Report one transaction. Never throws: an orchestrator that is down, or that
 * refuses the hash, is an answer to print, not a reason to fail the command
 * whose transaction already landed.
 */
export async function reportGas(args: string[], report: GasReport): Promise<GasReportResult> {
  try {
    const body = await orchFetch<{
      feeWei: string | null;
      status: string;
      payer: string;
    }>(args, "/usage/gas", { method: "POST", body: JSON.stringify(report) });
    return {
      txHash: report.txHash,
      recorded: true,
      feeWei: body.feeWei,
      status: body.status,
      payer: body.payer,
    };
  } catch (err) {
    const reason =
      err instanceof OrchRefusal
        ? err.message.split("\n")[0]!
        : `orchestrator_unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return { txHash: report.txHash, recorded: false, reason };
  }
}

const pending: Array<Promise<GasReportResult>> = [];

/** The slice of the SDK client this needs: its write-receipt hook. */
type WriteObservable = {
  observeWrites?: (observer: (receipt: { txHash: string; action: string }) => void) => unknown;
};

/**
 * Report every write `client` sends for the rest of this invocation, when the
 * invocation asked for it. Reports are sent as receipts arrive and collected
 * by `flushGasReports`, so a command's own output is not held up by them.
 */
export function watchClientGas(client: WriteObservable, args: string[]): void {
  if (!gasReportingEnabled(args) || typeof client.observeWrites !== "function") return;
  const payer = gasPayerFrom(args);
  client.observeWrites((receipt) => {
    pending.push(
      reportGas(args, {
        txHash: receipt.txHash,
        kind: `cli ${receipt.action}`,
        ...(payer ? { payer } : {}),
      }),
    );
  });
}

function printResult(result: GasReportResult): void {
  // stderr: a command's stdout is often JSON that something else parses.
  console.error(
    result.recorded
      ? `gas ${result.txHash} recorded (${result.payer}, ${result.status}, ` +
          `${result.feeWei === null ? "fee unknown" : `${result.feeWei} wei`})`
      : `gas ${result.txHash} not recorded: ${result.reason}`,
  );
}

/** Wait for the reports this invocation started, and say what became of each. */
export async function flushGasReports(): Promise<GasReportResult[]> {
  const results = await Promise.all(pending.splice(0));
  for (const result of results) printResult(result);
  return results;
}

/**
 * Transaction hashes from forge's record of the last `lacrew deploy` on a
 * chain, in broadcast order.
 */
export function deployTransactionHashes(contractsDir: string, chainId: string): string[] {
  const file = join(contractsDir, "broadcast", "DeployMockOrg.s.sol", chainId, "run-latest.json");
  if (!existsSync(file)) {
    throw new Error(`No deploy broadcast for chain ${chainId} (${file}). Run: lacrew deploy`);
  }
  const run = JSON.parse(readFileSync(file, "utf8")) as {
    transactions?: Array<{ hash?: unknown }>;
  };
  return (run.transactions ?? [])
    .map((tx) => tx.hash)
    .filter((hash): hash is string => typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash));
}

function usage(): void {
  console.error(
    [
      "Usage:",
      "  lacrew gas report <txHash>…   Report transactions to a running orchestrator",
      "  lacrew gas report --deploy    Report what the last `lacrew deploy` broadcast",
      "",
      "Options:",
      "  --gas-payer <orchestrator|agent|approver>  Who paid (default: orchestrator)",
      "  --agent <0x…>          The agent seat the transactions were sent for",
      "  --kind <label>         What they were for (default: cli report / deploy)",
      "  --chain-id <id>        --deploy only: which chain's broadcast (default: CHAIN_ID or 31337)",
      "  --url <orchestrator>   Default ORCH_URL or http://127.0.0.1:8788",
      "",
      "The orchestrator reads each receipt from its own chain and records only",
      "transactions sent to its deployment, so a fee is never taken on trust.",
      "Any command that writes also takes --report-gas (or LACREW_REPORT_GAS=1)",
      "to report its own transactions as it sends them.",
    ].join("\n"),
  );
}

export async function cmdGas(args: string[], contractsDir: string): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "report") {
    usage();
    if (sub && sub !== "help") process.exitCode = 1;
    return;
  }
  const deploy = hasFlag(rest, "--deploy");
  const valueFlags = new Set(["--gas-payer", "--agent", "--kind", "--chain-id", "--url"]);
  const hashes = deploy
    ? deployTransactionHashes(
        contractsDir,
        flagValue(rest, "--chain-id") ?? String(process.env.CHAIN_ID ?? "31337"),
      )
    : rest.filter((arg, i) => !arg.startsWith("-") && !valueFlags.has(rest[i - 1] ?? ""));
  if (hashes.length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }
  const payer = gasPayerFrom(rest);
  const agent = flagValue(rest, "--agent");
  const kind = flagValue(rest, "--kind") ?? (deploy ? "deploy" : "cli report");
  let recorded = 0;
  for (const txHash of hashes) {
    const result = await reportGas(rest, {
      txHash,
      kind,
      ...(payer ? { payer } : {}),
      ...(agent ? { agent } : {}),
    });
    printResult(result);
    if (result.recorded) recorded += 1;
  }
  console.log(`${recorded} of ${hashes.length} recorded`);
  if (recorded < hashes.length) process.exitCode = 1;
}
