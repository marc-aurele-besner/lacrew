import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskRpcUrl, parseWatchlist, watchlistFromEnv } from "./walletWatchlist.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe("parseWatchlist", () => {
  it("accepts a chain with an endpoint and tokens", () => {
    const parsed = parseWatchlist([
      {
        chainId: 8453,
        rpcUrl: "https://base-mainnet.example/v2/key",
        tokens: [{ symbol: "USDC", address: USDC, decimals: 6 }],
      },
    ]);
    assert.ok(parsed.ok);
    assert.equal(parsed.value[0]?.chainId, 8453);
    assert.equal(parsed.value[0]?.tokens[0]?.decimals, 6);
  });

  it("accepts a watched chain with no endpoint", () => {
    // "We care about this chain and cannot see it yet" is a real state, and
    // the read reports it rather than inventing zero balances.
    const parsed = parseWatchlist([{ chainId: 42161, tokens: [] }]);
    assert.ok(parsed.ok);
    assert.equal(parsed.value[0]?.rpcUrl, undefined);
  });

  it("refuses an address that is not 20 bytes", () => {
    // The failure this guards: `balanceOf` on a non-contract does not throw,
    // it reads empty — and a zero the operator trusts is worse than an error.
    const parsed = parseWatchlist([
      { chainId: 1, tokens: [{ symbol: "USDC", address: USDC.slice(0, -1), decimals: 6 }] },
    ]);
    assert.equal(parsed.ok, false);
    assert.match((parsed as { error: string }).error, /not a 20-byte hex address/);
  });

  it("refuses missing or absurd decimals rather than assuming 18", () => {
    // Guessing 18 for a 6-decimal token misplaces the point by 10^12.
    for (const decimals of [undefined, -1, 37, 6.5]) {
      const parsed = parseWatchlist([
        { chainId: 1, tokens: [{ symbol: "USDC", address: USDC, decimals }] },
      ]);
      assert.equal(parsed.ok, false, `decimals ${String(decimals)} should be refused`);
    }
    // Zero is legitimate — some tokens genuinely use it.
    assert.ok(parseWatchlist([{ chainId: 1, tokens: [{ symbol: "X", address: USDC, decimals: 0 }] }]).ok);
  });

  it("refuses a duplicate chain or a duplicate token", () => {
    assert.equal(
      parseWatchlist([{ chainId: 1, tokens: [] }, { chainId: 1, tokens: [] }]).ok,
      false,
    );
    // The same contract twice would double it in any total summed from rows.
    const dup = parseWatchlist([
      {
        chainId: 1,
        tokens: [
          { symbol: "USDC", address: USDC, decimals: 6 },
          { symbol: "usdc", address: USDC.toLowerCase(), decimals: 6 },
        ],
      },
    ]);
    assert.equal(dup.ok, false);
    assert.match((dup as { error: string }).error, /listed twice/);
  });

  it("refuses a non-http endpoint and a non-array watchlist", () => {
    assert.equal(parseWatchlist([{ chainId: 1, rpcUrl: "ws://x", tokens: [] }]).ok, false);
    assert.equal(parseWatchlist({ chainId: 1 }).ok, false);
    // Absent is empty, not an error — the common case for a fresh workspace.
    assert.deepEqual(parseWatchlist(null), { ok: true, value: [] });
  });
});

describe("watchlistFromEnv", () => {
  it("reads a JSON array and ignores anything malformed", () => {
    const list = watchlistFromEnv(JSON.stringify([{ chainId: 10, tokens: [] }]));
    assert.equal(list[0]?.chainId, 10);
    // A bad env var must not take the orchestrator down, and must not be
    // half-applied either — it is dropped whole.
    assert.deepEqual(watchlistFromEnv("not json"), []);
    assert.deepEqual(watchlistFromEnv(JSON.stringify([{ chainId: 0 }])), []);
    assert.deepEqual(watchlistFromEnv(undefined), []);
  });
});

describe("maskRpcUrl", () => {
  it("keeps the host and drops the credential", () => {
    // Provider keys ride in the path; this value is echoed by a GET route.
    assert.equal(
      maskRpcUrl("https://base-mainnet.g.alchemy.com/v2/SECRET_KEY"),
      "https://base-mainnet.g.alchemy.com/v2/…",
    );
    assert.equal(maskRpcUrl("https://rpc.example.com"), "https://rpc.example.com");
    assert.equal(maskRpcUrl("nonsense"), "…");
  });

  it("drops a key carried in the query string too", () => {
    assert.equal(
      maskRpcUrl("https://rpc.example.com/eth?apikey=SECRET"),
      "https://rpc.example.com/eth/…",
    );
  });
});
