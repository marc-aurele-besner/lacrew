/**
 * Play-money top-ups: when a deployment counts as a sandbox, who may be
 * credited, which contract path the credit takes, and how each refusal is
 * served over HTTP.
 *
 * The client is a fake that reads as onchain and answers the handful of calls
 * the sandbox surface makes — no chain is dialed, and every write it is asked
 * for is recorded so a refusal can be shown to have sent nothing. The SDK
 * methods it stands in for are tested against a stub transport in
 * `@lacrew/sdk` (onchainWrites.test.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANVIL_CHAIN_ID,
  BASE_CHAIN_ID,
  MAINNET_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  type OrgNode,
} from "@lacrew/core";
import { FaucetCooldownError, type MockTokenFaucet } from "@lacrew/sdk";
import { createLacrewClient } from "@lacrew/sdk/testing";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createOrchestratorApp } from "./httpApp.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import { CrewRuntime, SandboxError } from "./runtime.js";

const addr = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
const TREASURY = addr("2");
const MOCK_USDC = addr("6");
const REAL_USDC = addr("7");
const ROOT = addr("a");
const WORKER = addr("b");
const FIRED = addr("c");
const STRANGER = addr("d");
const SIGNER = addr("e");
const TX = `0x${"11".repeat(32)}` as `0x${string}`;
const DRIP = 100_000_000n;

const TREE: OrgNode[] = [
  { account: ROOT, kind: "human_root", parent: null, active: true },
  { account: WORKER, kind: "worker_agent", parent: ROOT, active: true },
  { account: FIRED, kind: "worker_agent", parent: ROOT, active: false },
];

type Writes = Array<{ fn: "mint" | "drip"; to: string; amount?: bigint }>;

function sandboxRuntime(
  opts: {
    chainId?: number;
    /** What the endpoint itself reports; defaults to `chainId`. */
    reportedChainId?: number;
    mockUSDC?: `0x${string}` | null;
    spendToken?: `0x${string}`;
    canMint?: boolean;
    signer?: `0x${string}` | null;
    /** Seconds the faucet is still closed for the signer. */
    faucetWait?: number;
    tokenThrows?: boolean;
    writes?: Writes;
    /** Counts every chain read, to show a refusal made none. */
    reads?: { n: number };
  } = {},
) {
  const chainId = opts.chainId ?? ANVIL_CHAIN_ID;
  const mockUSDC = opts.mockUSDC === null ? undefined : (opts.mockUSDC ?? MOCK_USDC);
  const read = <T>(value: T): T => {
    if (opts.reads) opts.reads.n += 1;
    return value;
  };
  const wait = opts.faucetWait ?? 0;
  const client = {
    getAuditTrail: async () => [],
    publicClient: { getChainId: async () => read(opts.reportedChainId ?? chainId) },
    chainId,
    addresses: { chainId, treasury: TREASURY, ...(mockUSDC ? { mockUSDC } : {}) },
    getOrgTree: async () => read(TREE),
    readSpendToken: async () => read(opts.spendToken ?? MOCK_USDC),
    readMockTokenFaucet: async (token: `0x${string}`): Promise<MockTokenFaucet> => {
      if (opts.tokenThrows) throw new Error("execution reverted");
      return read({
        token,
        symbol: "mUSDC",
        decimals: 6,
        faucetAmount: DRIP,
        cooldownSeconds: 86_400,
        signer: opts.signer === undefined ? SIGNER : opts.signer,
        canMint: opts.canMint ?? true,
      });
    },
    readFaucetWait: async () =>
      read({ availableAt: wait ? 1_000 + wait : 0, retryAfterSeconds: wait }),
    mintMockToken: async (_token: `0x${string}`, to: `0x${string}`, amount: bigint) => {
      opts.writes?.push({ fn: "mint", to, amount });
      return { txHash: TX };
    },
    dripMockToken: async (_token: `0x${string}`, to: `0x${string}`) => {
      if (wait) throw new FaucetCooldownError(1_000 + wait, wait);
      opts.writes?.push({ fn: "drip", to });
      return { txHash: TX, faucetTxHash: TX, amount: DRIP };
    },
  } as unknown as ConstructorParameters<typeof CrewRuntime>[0]["client"];
  return new CrewRuntime({
    client,
    mode: "onchain",
    chainId,
    workerAgent: WORKER,
    managerAgent: ROOT,
    spendTarget: addr("f"),
  });
}

/** The refusal code a top-up is rejected with. */
async function refusal(run: Promise<unknown>): Promise<SandboxError> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof SandboxError, `expected a SandboxError, got ${String(err)}`);
    return err;
  }
  throw new Error("expected the top-up to be refused");
}

describe("sandboxStatus", () => {
  it("is not a sandbox with no chain bound", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.deepEqual(await runtime.sandboxStatus(), {
      sandbox: false,
      chainId: null,
      reason: "no_chain",
    });
  });

  it("is a sandbox on a test chain whose Treasury spends the MockUSDC", async () => {
    for (const chainId of [ANVIL_CHAIN_ID, SEPOLIA_CHAIN_ID]) {
      assert.deepEqual(await sandboxRuntime({ chainId }).sandboxStatus(), {
        sandbox: true,
        chainId,
        token: { address: MOCK_USDC, symbol: "mUSDC", decimals: 6 },
        faucetAmount: "100000000",
        cooldownSeconds: 0,
        via: "mint",
      });
    }
  });

  it("reports the faucet's cooldown when the signer cannot mint", async () => {
    const status = await sandboxRuntime({ canMint: false, faucetWait: 600 }).sandboxStatus();
    assert.equal(status.sandbox, true);
    assert.equal(status.via, "faucet");
    assert.equal(status.cooldownSeconds, 86_400);
    assert.equal(status.retryAfterSeconds, 600);
  });

  it("refuses a mainnet id with a MockUSDC address set, without reading the chain", async () => {
    for (const chainId of [MAINNET_CHAIN_ID, BASE_CHAIN_ID]) {
      const reads = { n: 0 };
      assert.deepEqual(await sandboxRuntime({ chainId, reads }).sandboxStatus(), {
        sandbox: false,
        chainId,
        reason: "not_test_chain",
      });
      assert.equal(reads.n, 0);
    }
  });

  it("refuses a test chain with no MockUSDC in the address book", async () => {
    const status = await sandboxRuntime({ mockUSDC: null }).sandboxStatus();
    assert.deepEqual(status, { sandbox: false, chainId: ANVIL_CHAIN_ID, reason: "no_mock_token" });
  });

  it("refuses a test chain whose Treasury spends another token", async () => {
    // The address book names a MockUSDC, and the Treasury holds something else:
    // the Treasury's own answer decides.
    const status = await sandboxRuntime({ spendToken: REAL_USDC }).sandboxStatus();
    assert.equal(status.sandbox, false);
    assert.equal(status.reason, "spend_token_not_mock");
  });

  it("refuses when the endpoint reports a different chain than the one bound", async () => {
    const status = await sandboxRuntime({ reportedChainId: MAINNET_CHAIN_ID }).sandboxStatus();
    assert.equal(status.sandbox, false);
    assert.equal(status.reason, "chain_id_mismatch");
  });

  it("refuses a token that does not answer as a MockUSDC", async () => {
    const status = await sandboxRuntime({ tokenThrows: true }).sandboxStatus();
    assert.equal(status.sandbox, false);
    assert.equal(status.reason, "token_unreadable");
  });

  it("refuses a runtime that cannot sign the top-up", async () => {
    const status = await sandboxRuntime({ signer: null, canMint: false }).sandboxStatus();
    assert.equal(status.sandbox, false);
    assert.equal(status.reason, "no_signer");
  });
});

describe("sandboxTopUp", () => {
  it("mints the fixed faucet amount to an org node and records it", async () => {
    const writes: Writes = [];
    const runtime = sandboxRuntime({ writes });
    assert.deepEqual(await runtime.sandboxTopUp({ account: WORKER }), {
      account: WORKER,
      amount: "100000000",
      txHash: TX,
      token: { address: MOCK_USDC, symbol: "mUSDC", decimals: 6 },
      via: "mint",
    });
    assert.deepEqual(writes, [{ fn: "mint", to: WORKER, amount: DRIP }]);

    const event = (await runtime.audit()).find((e) => e.type === "SandboxTopUp");
    assert.ok(event, "the top-up is in the audit trail");
    assert.equal(event.payload.account, WORKER);
    assert.equal(event.payload.amount, "100000000");
    assert.equal(event.payload.txHash, TX);
    assert.equal(event.chainId, ANVIL_CHAIN_ID);
  });

  it("credits the Treasury and the human root, matched case-insensitively", async () => {
    const writes: Writes = [];
    const runtime = sandboxRuntime({ writes });
    await runtime.sandboxTopUp({ account: TREASURY });
    await runtime.sandboxTopUp({ account: ROOT.toUpperCase().replace("0X", "0x") });
    assert.deepEqual(
      writes.map((w) => w.to.toLowerCase()),
      [TREASURY, ROOT],
    );
  });

  it("drips through the faucet when the signer is not a minter", async () => {
    const writes: Writes = [];
    const result = await sandboxRuntime({ canMint: false, writes }).sandboxTopUp({
      account: WORKER,
    });
    assert.equal(result.via, "faucet");
    assert.equal(result.amount, "100000000");
    assert.deepEqual(writes, [{ fn: "drip", to: WORKER }]);
  });

  it("relays the faucet cooldown with the seconds remaining, and records nothing", async () => {
    const writes: Writes = [];
    const runtime = sandboxRuntime({ canMint: false, faucetWait: 600, writes });
    const err = await refusal(runtime.sandboxTopUp({ account: WORKER }));
    assert.equal(err.code, "faucet_cooldown");
    assert.equal(err.detail.retryAfterSeconds, 600);
    assert.deepEqual(writes, []);
    assert.ok(!(await runtime.audit()).some((e) => e.type === "SandboxTopUp"));
  });

  it("refuses an address outside the org, and a fired node", async () => {
    const writes: Writes = [];
    const runtime = sandboxRuntime({ writes });
    for (const account of [STRANGER, SIGNER, FIRED]) {
      assert.equal((await refusal(runtime.sandboxTopUp({ account }))).code, "account_not_in_org");
    }
    assert.deepEqual(writes, []);
  });

  it("refuses anything that is not a 20-byte hex address", async () => {
    const writes: Writes = [];
    const runtime = sandboxRuntime({ writes });
    for (const account of ["", "worker", "0x1234", `${WORKER}00`, undefined, 7]) {
      const err = await refusal(runtime.sandboxTopUp({ account: account as string }));
      assert.equal(err.code, "invalid_account");
    }
    assert.deepEqual(writes, []);
  });

  it("refuses on a mainnet id, whatever the address book says, and sends nothing", async () => {
    const writes: Writes = [];
    const runtime = sandboxRuntime({ chainId: BASE_CHAIN_ID, writes });
    const err = await refusal(runtime.sandboxTopUp({ account: WORKER }));
    assert.equal(err.code, "not_sandbox");
    assert.equal(err.detail.reason, "not_test_chain");
    assert.deepEqual(writes, []);
  });

  it("refuses when the Treasury spends a real token, and with no chain bound", async () => {
    const writes: Writes = [];
    const real = sandboxRuntime({ spendToken: REAL_USDC, writes });
    assert.equal((await refusal(real.sandboxTopUp({ account: WORKER }))).code, "not_sandbox");
    assert.deepEqual(writes, []);

    const chainless = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const err = await refusal(chainless.sandboxTopUp({ account: WORKER }));
    assert.equal(err.code, "not_sandbox");
    assert.equal(err.detail.reason, "no_chain");
  });
});

describe("sandbox routes", () => {
  function appFor(runtime: CrewRuntime, authToken?: string) {
    const model = new MemoryModelProvider();
    return createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model,
      flows: createFlowsSurface({
        runtime,
        model,
        mcpBackend: {} as McpToolBackend,
        store: createMemoryFlowStore(),
      }),
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
      ...(authToken ? { authToken } : {}),
    });
  }

  const topUp = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://x/sandbox/top-up", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("GET /sandbox serves the status, and a non-sandbox is a 200 with a reason", async () => {
    const yes = await appFor(sandboxRuntime()).request("/sandbox");
    assert.equal(yes.status, 200);
    assert.deepEqual(await yes.json(), {
      sandbox: true,
      chainId: ANVIL_CHAIN_ID,
      token: { address: MOCK_USDC, symbol: "mUSDC", decimals: 6 },
      faucetAmount: "100000000",
      cooldownSeconds: 0,
      via: "mint",
      mode: "onchain",
    });

    const no = await appFor(sandboxRuntime({ chainId: BASE_CHAIN_ID })).request("/sandbox");
    assert.equal(no.status, 200);
    assert.deepEqual(await no.json(), {
      sandbox: false,
      chainId: BASE_CHAIN_ID,
      reason: "not_test_chain",
      mode: "onchain",
    });
  });

  it("POST /sandbox/top-up credits an org account", async () => {
    const writes: Writes = [];
    const res = await appFor(sandboxRuntime({ writes })).request(topUp({ account: WORKER }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      account: WORKER,
      amount: "100000000",
      txHash: TX,
      token: { address: MOCK_USDC, symbol: "mUSDC", decimals: 6 },
      via: "mint",
      mode: "onchain",
    });
    assert.deepEqual(writes, [{ fn: "mint", to: WORKER, amount: DRIP }]);
  });

  it("serves each refusal as its own stable 4xx", async () => {
    const cases: Array<[CrewRuntime, unknown, number, Record<string, unknown>]> = [
      [
        sandboxRuntime({ chainId: BASE_CHAIN_ID }),
        { account: WORKER },
        409,
        { error: "not_sandbox", reason: "not_test_chain" },
      ],
      [sandboxRuntime(), { account: "nope" }, 400, { error: "invalid_account" }],
      [sandboxRuntime(), {}, 400, { error: "invalid_account" }],
      [sandboxRuntime(), { account: STRANGER }, 403, { error: "account_not_in_org" }],
      [
        sandboxRuntime({ canMint: false, faucetWait: 600 }),
        { account: WORKER },
        429,
        { error: "faucet_cooldown", retryAfterSeconds: 600 },
      ],
    ];
    for (const [runtime, body, status, expected] of cases) {
      const res = await appFor(runtime).request(topUp(body));
      assert.equal(res.status, status, JSON.stringify(expected));
      assert.deepEqual(await res.json(), expected);
    }
  });

  it("sets Retry-After on a cooldown refusal", async () => {
    const res = await appFor(sandboxRuntime({ canMint: false, faucetWait: 600 })).request(
      topUp({ account: WORKER }),
    );
    assert.equal(res.headers.get("retry-after"), "600");
  });

  it("refuses a caller-chosen amount rather than ignoring it", async () => {
    const writes: Writes = [];
    const res = await appFor(sandboxRuntime({ writes })).request(
      topUp({ account: WORKER, amount: "1000000000000" }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "amount_is_fixed" });
    assert.deepEqual(writes, []);
  });

  it("sits behind the bearer token like every other route", async () => {
    const writes: Writes = [];
    const app = appFor(sandboxRuntime({ writes }), "s3cret");
    assert.equal((await app.request(topUp({ account: WORKER }))).status, 401);
    assert.equal((await app.request("/sandbox")).status, 401);
    assert.deepEqual(writes, []);

    const ok = await app.request(topUp({ account: WORKER }, { authorization: "Bearer s3cret" }));
    assert.equal(ok.status, 200);
    assert.equal(writes.length, 1);
  });
});
