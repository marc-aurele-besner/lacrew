/**
 * Onchain client behavior that needs no chain: write confirmation, session
 * issuance shape selection, session read-back mapping, and the marketplace
 * price guard. The transport is a stub — nothing is broadcast anywhere.
 *
 * The write-confirmation tests exist for one reason: a mined transaction is
 * not a successful one. Before confirmWrite, a reverted revoke came back as
 * `{ txHash }` like any success, which for a leaked session key means "your
 * revoke did nothing" reads as "you are safe".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Abi,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ANVIL_CHAIN_ID,
  getAddresses,
  marketplacePaymentsAbi,
  sessionRegistryAbi,
  sessionScopesFromMask,
} from "@lacrew/core";
import { createOnchainClient, readTokenMetadata } from "./onchain.js";

/** Anvil account 0 — signing only; the stub transport swallows everything. */
const MAIN = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const WORKER = "0x3333333333333333333333333333333333333333" as const;
const KEY = "0x4444444444444444444444444444444444444444" as const;
const TARGET_A = "0x5555555555555555555555555555555555555555" as const;
const TARGET_B = "0x6666666666666666666666666666666666666666" as const;

type CallHandlers = Record<string, (args: readonly unknown[]) => unknown>;

/**
 * Answer eth_call by decoding the function selector against known ABIs and
 * encoding the handler's return, so a test states results per function
 * instead of per raw calldata.
 */
function answerCalls(abis: Abi[], handlers: CallHandlers) {
  return (data: Hex): Hex => {
    for (const abi of abis) {
      let decoded: { functionName: string; args?: readonly unknown[] };
      try {
        decoded = decodeFunctionData({ abi, data });
      } catch {
        continue;
      }
      const handler = handlers[decoded.functionName];
      if (!handler) break;
      return encodeFunctionResult({
        abi,
        functionName: decoded.functionName,
        result: handler(decoded.args ?? []),
      } as never);
    }
    throw new Error(`unstubbed eth_call: ${data.slice(0, 10)}`);
  };
}

/** Just enough JSON-RPC to sign, "land" and confirm transactions. */
function stubTransport(opts: {
  receiptStatus?: "0x1" | "0x0";
  onCall?: (data: Hex) => Hex;
  sent?: Hex[];
  calls?: Hex[];
}) {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      switch (method) {
        case "eth_chainId":
          return `0x${ANVIL_CHAIN_ID.toString(16)}`;
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_estimateGas":
          return "0x186a0";
        case "eth_gasPrice":
        case "eth_maxPriorityFeePerGas":
          return "0x3b9aca00";
        case "eth_getBlockByNumber":
          return { baseFeePerGas: "0x3b9aca00", number: "0x1", timestamp: "0x1" };
        case "eth_blockNumber":
          return "0x1";
        case "eth_sendRawTransaction":
          opts.sent?.push((params as Hex[])[0]!);
          return "0x" + "11".repeat(32);
        case "eth_getTransactionReceipt":
          return {
            transactionHash: "0x" + "11".repeat(32),
            blockNumber: "0x1",
            blockHash: "0x" + "22".repeat(32),
            transactionIndex: "0x0",
            status: opts.receiptStatus ?? "0x1",
            gasUsed: "0x186a0",
            cumulativeGasUsed: "0x186a0",
            effectiveGasPrice: "0x3b9aca00",
            logs: [],
            type: "0x2",
            from: MAIN.address,
            to: getAddresses(ANVIL_CHAIN_ID).escalationRouter,
            contractAddress: null,
            logsBloom: "0x" + "00".repeat(256),
          };
        case "eth_call": {
          const data = (params as Array<{ data: Hex }>)[0]!.data;
          opts.calls?.push(data);
          if (!opts.onCall) throw new Error(`unstubbed eth_call: ${data.slice(0, 10)}`);
          return opts.onCall(data);
        }
        default:
          throw new Error(`unstubbed rpc: ${method}`);
      }
    },
  });
}

function clientWith(opts: Parameters<typeof stubTransport>[0]) {
  return createOnchainClient({
    transport: stubTransport(opts),
    account: MAIN,
    chainId: ANVIL_CHAIN_ID,
    addresses: getAddresses(ANVIL_CHAIN_ID),
  });
}

describe("confirmWrite refuses reverted receipts", () => {
  it("a reverted session revoke throws instead of reporting a hash", async () => {
    const client = clientWith({ receiptStatus: "0x0" });
    await assert.rejects(() => client.revokeSession("5"), /session revoke reverted onchain: 0x/);
  });

  it("a reverted governance vote throws with the operation named", async () => {
    const client = clientWith({ receiptStatus: "0x0" });
    await assert.rejects(
      () => client.voteGovernance("3", true),
      /governance vote reverted onchain/,
    );
  });

  it("a successful write still reports its hash", async () => {
    const client = clientWith({ receiptStatus: "0x1" });
    const { txHash } = await client.voteGovernance("3", true);
    assert.match(txHash, /^0x11/);
  });
});

describe("issueSession picks the narrowest issuance the inputs allow", () => {
  async function issuedFunction(
    input: Parameters<ReturnType<typeof clientWith>["issueSession"]>[0],
  ) {
    const calls: Hex[] = [];
    const client = clientWith({
      calls,
      onCall: answerCalls([sessionRegistryAbi as Abi], {
        issue: () => 42n,
        issueScoped: () => 42n,
        issueScopedTimed: () => 42n,
      }),
    });
    const { sessionId } = await client.issueSession(input);
    assert.equal(sessionId, "42");
    const simulate = calls[calls.length - 1]!;
    return decodeFunctionData({ abi: sessionRegistryAbi as Abi, data: simulate });
  }

  const base = { agent: WORKER, key: KEY, expiresAtSec: 4102444800, scopeMask: 3n };

  it("a plain key rides the simple issue path", async () => {
    const { functionName } = await issuedFunction({ ...base, allowedTarget: TARGET_A });
    assert.equal(functionName, "issue");
  });

  it("two pinned targets require issueScoped — dropping to one would silently narrow the key", async () => {
    const { functionName, args } = await issuedFunction({
      ...base,
      allowedTargets: [TARGET_A, TARGET_B],
    });
    assert.equal(functionName, "issueScoped");
    assert.deepEqual(args![5], [TARGET_A, TARGET_B]);
  });

  it("a window or rate limit requires issueScopedTimed so the chain enforces them", async () => {
    const { functionName, args } = await issuedFunction({
      ...base,
      window: { start: 3600, end: 7200 },
      rate: { maxProposals: 2, ratePeriod: 60 },
    });
    assert.equal(functionName, "issueScopedTimed");
    assert.equal(args![6], 3600);
    assert.equal(args![8], 2);
  });
});

describe("getSessions maps every bound the registry holds", () => {
  it("reads targets, window and rate from their own storage, not the struct alone", async () => {
    const expiresAtSec = 4102444800; // far future: the key is live
    const client = clientWith({
      onCall: answerCalls([sessionRegistryAbi as Abi], {
        sessionsOf: () => [1n],
        sessions: () => [
          WORKER,
          KEY,
          BigInt(expiresAtSec),
          3n,
          1000n,
          TARGET_A,
          false,
          true,
          3600,
          7200,
        ],
        rateLimits: () => [2, 60, 0n, 0],
        allowedTargetsOf: () => [TARGET_A, TARGET_B],
      }),
    });
    const sessions = await client.getSessions(WORKER);
    assert.equal(sessions.length, 1);
    const [session] = sessions;
    assert.equal(session!.keyId, "1");
    assert.equal(session!.keyAddress, KEY);
    assert.equal(session!.expiresAt, expiresAtSec * 1000);
    assert.deepEqual(session!.scopes, sessionScopesFromMask(3n));
    assert.equal(session!.maxValue, "1000");
    // The struct's allowedTarget is only the first pin; the full set must come
    // from allowedTargetsOf or a rotation would shrink the key.
    assert.deepEqual(session!.allowedTargets, [TARGET_A, TARGET_B]);
    assert.deepEqual(session!.window, { start: 3600, end: 7200 });
    assert.deepEqual(session!.rate, { maxProposals: 2, ratePeriod: 60 });
    assert.equal(session!.revoked, false);
  });

  it("reports an expired key as revoked even when the registry has not marked it", async () => {
    const client = clientWith({
      onCall: answerCalls([sessionRegistryAbi as Abi], {
        sessionsOf: () => [1n],
        sessions: () => [WORKER, KEY, 1000n, 3n, 1000n, TARGET_A, false, true, 0, 0],
        rateLimits: () => [0, 0, 0n, 0],
        allowedTargetsOf: () => [],
      }),
    });
    const [session] = await client.getSessions(WORKER);
    assert.equal(session!.revoked, true);
    assert.equal(session!.window, undefined);
    assert.equal(session!.rate, undefined);
  });
});

describe("purchaseListing price guard", () => {
  it("refuses a quote above maxPrice before approving or broadcasting anything", async () => {
    const sent: Hex[] = [];
    const client = clientWith({
      sent,
      onCall: answerCalls([marketplacePaymentsAbi as Abi], {
        quote: () => [100n, 3n, 97n],
        feeBps: () => 300,
      }),
    });
    await assert.rejects(
      () => client.purchaseListing({ catalogId: "flow-1", maxPrice: 50n }),
      /exceeds maxPrice 50/,
    );
    // No approve went out: a guaranteed-revert purchase must not leave a live
    // ERC-20 allowance to the market behind it.
    assert.deepEqual(sent, []);
  });
});

describe("readTokenMetadata", () => {
  const fakePublicClient = (impl: {
    getCode?: () => Promise<Hex | undefined>;
    reads?: Record<string, unknown>;
  }) =>
    ({
      getCode: impl.getCode ?? (async () => "0x6001" as Hex),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (impl.reads && functionName in impl.reads) return impl.reads[functionName];
        throw Object.assign(new Error("no metadata"), { name: "ContractFunctionExecutionError" });
      },
    }) as unknown as PublicClient;

  it("answers with trimmed symbol and decimals from the contract itself", async () => {
    const result = await readTokenMetadata(
      fakePublicClient({ reads: { symbol: " USDC ", decimals: 6 } }),
      TARGET_A,
    );
    assert.deepEqual(result, { ok: true, symbol: "USDC", decimals: 6 });
  });

  it("an address with no code is definitively not_erc20", async () => {
    const result = await readTokenMetadata(
      fakePublicClient({ getCode: async () => "0x" }),
      TARGET_A,
    );
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "not_erc20");
  });

  it("an unreachable RPC is never conflated with a bad address", async () => {
    const result = await readTokenMetadata(
      fakePublicClient({
        getCode: async () => {
          throw new Error("fetch failed");
        },
      }),
      TARGET_A,
    );
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "unreachable");
  });

  it("nonsense decimals mean the contract is not an ERC-20", async () => {
    const result = await readTokenMetadata(
      fakePublicClient({ reads: { symbol: "X", decimals: 255 } }),
      TARGET_A,
    );
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "not_erc20");
  });

  it("a contract without the metadata functions is not_erc20, not a retry", async () => {
    const result = await readTokenMetadata(fakePublicClient({}), TARGET_A);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "not_erc20");
  });
});
