import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployTransactionHashes,
  flushGasReports,
  gasPayerFrom,
  gasReportingEnabled,
  reportGas,
  watchClientGas,
} from "./gas.js";

const TX = `0x${"ab".repeat(32)}`;

describe("gas reporting", () => {
  const env = { ...process.env };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    process.env = { ...env };
    globalThis.fetch = realFetch;
  });

  /** Answer every request with `body`, and keep what was sent. */
  function orchestrator(status: number, body: unknown) {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return calls;
  }

  it("is off unless asked for", () => {
    delete process.env.LACREW_REPORT_GAS;
    assert.equal(gasReportingEnabled([]), false);
    assert.equal(gasReportingEnabled(["--report-gas"]), true);
    process.env.LACREW_REPORT_GAS = "1";
    assert.equal(gasReportingEnabled([]), true);
  });

  it("reads the payer from the flag, then the environment, and refuses an unknown one", () => {
    delete process.env.LACREW_GAS_PAYER;
    assert.equal(gasPayerFrom([]), undefined);
    process.env.LACREW_GAS_PAYER = "approver";
    assert.equal(gasPayerFrom([]), "approver");
    assert.equal(gasPayerFrom(["--gas-payer", "agent"]), "agent");
    // Sponsorship cannot be shown by a transaction hash.
    assert.throws(() => gasPayerFrom(["--gas-payer", "sponsored"]), /Unknown gas payer/);
  });

  it("posts the hash and what it was for, and never a fee", async () => {
    const calls = orchestrator(200, { feeWei: "400", status: "success", payer: "orchestrator" });
    const result = await reportGas(["--url", "http://orch:1"], { txHash: TX, kind: "cli vote" });
    assert.deepEqual(calls, [
      { url: "http://orch:1/usage/gas", body: { txHash: TX, kind: "cli vote" } },
    ]);
    assert.deepEqual(result, {
      txHash: TX,
      recorded: true,
      feeWei: "400",
      status: "success",
      payer: "orchestrator",
    });
  });

  it("turns a refusal or an unreachable orchestrator into an answer, not a throw", async () => {
    orchestrator(422, { error: "unexpected_target" });
    assert.deepEqual(await reportGas([], { txHash: TX, kind: "x" }), {
      txHash: TX,
      recorded: false,
      reason: "unexpected_target",
    });
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const down = await reportGas([], { txHash: TX, kind: "x" });
    assert.equal(down.recorded, false);
    assert.match(down.recorded ? "" : down.reason, /orchestrator_unreachable: ECONNREFUSED/);
  });

  it("reports each write a watched client sends, once flushed", async () => {
    const calls = orchestrator(200, { feeWei: "1", status: "success", payer: "approver" });
    let observer: ((receipt: { txHash: string; action: string }) => void) | undefined;
    const client = {
      observeWrites: (fn: typeof observer) => {
        observer = fn;
      },
    };
    watchClientGas(client, ["--report-gas", "--gas-payer", "approver"]);
    observer!({ txHash: TX, action: "governance vote" });
    const results = await flushGasReports();
    assert.equal(results.length, 1);
    assert.deepEqual(calls[0]!.body, {
      txHash: TX,
      kind: "cli governance vote",
      payer: "approver",
    });
    // Flushed once: nothing is reported twice.
    assert.deepEqual(await flushGasReports(), []);
  });

  it("does not watch a client when reporting was not asked for", () => {
    delete process.env.LACREW_REPORT_GAS;
    let watched = false;
    watchClientGas(
      {
        observeWrites: () => {
          watched = true;
        },
      },
      [],
    );
    assert.equal(watched, false);
  });

  it("reads the deploy's transaction hashes from forge's broadcast record", () => {
    const contracts = mkdtempSync(join(tmpdir(), "lacrew-gas-"));
    const dir = join(contracts, "broadcast", "DeployMockOrg.s.sol", "31337");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run-latest.json"),
      JSON.stringify({ transactions: [{ hash: TX }, { hash: null }, { hash: "0x12" }] }),
    );
    assert.deepEqual(deployTransactionHashes(contracts, "31337"), [TX]);
    assert.throws(() => deployTransactionHashes(contracts, "1"), /No deploy broadcast/);
  });
});
