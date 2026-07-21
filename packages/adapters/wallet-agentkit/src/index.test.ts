import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
  checkWithPolicy,
  createCdpWallet,
  createCdpWalletAdapter,
  createMockAgentKitWalletAdapter,
  mockAgentKitWalletAdapter,
  type AdapterCheckInput,
} from "./index.js";

const SPEND: AdapterCheckInput = {
  agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target: "0x4444444444444444444444444444444444444444",
  value: 200n * 10n ** 6n,
  data: "0x",
};

const OWNER = "0x1111111111111111111111111111111111111111";
const SMART = "0x2222222222222222222222222222222222222222";

/**
 * Throwaway credentials generated per run — never real keys. They only need to
 * be well-formed enough for the SDK to sign its request JWT; the mock server
 * does not verify them.
 */
function throwawayCredentials() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const apiKeySecret = Buffer.concat([
    privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32),
    publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  ]).toString("base64");
  const { privateKey: wallet } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    apiKeyId: "00000000-0000-0000-0000-000000000000",
    apiKeySecret,
    walletSecret: wallet.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

/** Stand-in for the CDP API so the real SDK can be exercised without a key. */
async function startMockCdp(): Promise<{
  basePath: string;
  paths: string[];
  close: () => Promise<void>;
}> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url?.includes("smart-accounts")
            ? { address: SMART, name: "worker-1", owners: [OWNER] }
            : { address: OWNER, name: "worker-1" },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    basePath: `http://127.0.0.1:${port}`,
    paths,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("mocked policy escalates over cap", () => {
  assert.equal(checkWithPolicy(SPEND), "ESCALATE");
  assert.equal(checkWithPolicy({ ...SPEND, value: 10n * 10n ** 6n }), "ALLOW");
});

test("bound mock adapter reads the verdict from the policy reader", async () => {
  const seen: AdapterCheckInput[] = [];
  const adapter = createMockAgentKitWalletAdapter({
    async checkPolicy(input) {
      seen.push(input);
      return "DENY";
    },
  });

  // The reader wins over the mock heuristic: 200 USDC would be ESCALATE.
  assert.equal(await adapter.checkPolicy(SPEND), "DENY");
  assert.deepEqual(seen, [SPEND]);
  assert.equal(adapter.provider, mockAgentKitWalletAdapter.provider);
});

test("reader failures surface instead of reading as ALLOW", async () => {
  const adapter = createMockAgentKitWalletAdapter({
    async checkPolicy() {
      throw new Error("rpc down");
    },
  });
  await assert.rejects(() => Promise.resolve(adapter.checkPolicy(SPEND)), /rpc down/);
});

test("CDP provisioning refuses to run without credentials", async () => {
  await assert.rejects(
    () =>
      createCdpWallet({
        name: "worker-1",
        apiKeyId: "",
        apiKeySecret: "",
        walletSecret: "",
      }),
    /CDP credentials missing/,
  );
});

test("real CDP SDK provisions a smart account over its owner", async () => {
  const cdp = await startMockCdp();
  try {
    const wallet = await createCdpWallet({
      ...throwawayCredentials(),
      basePath: cdp.basePath,
      name: "worker-1",
    });
    assert.equal(wallet.address, SMART);
    assert.equal(wallet.ownerAddress, OWNER);
    assert.equal(wallet.kind, "smart");
    // Proof the genuine SDK ran: these are CDP's documented v2 routes.
    assert.deepEqual(cdp.paths, [
      "GET /v2/evm/accounts/by-name/worker-1",
      "GET /v2/evm/smart-accounts/by-name/worker-1",
    ]);
  } finally {
    await cdp.close();
  }
});

test("server-account mode skips the smart account", async () => {
  const cdp = await startMockCdp();
  try {
    const wallet = await createCdpWallet({
      ...throwawayCredentials(),
      basePath: cdp.basePath,
      name: "worker-1",
      smartAccount: false,
    });
    assert.equal(wallet.address, OWNER);
    assert.equal(wallet.kind, "server");
    assert.deepEqual(cdp.paths, ["GET /v2/evm/accounts/by-name/worker-1"]);
  } finally {
    await cdp.close();
  }
});

test("CDP adapter provisions through createWallet and honours the reader", async () => {
  const cdp = await startMockCdp();
  try {
    const adapter = createCdpWalletAdapter({
      ...throwawayCredentials(),
      basePath: cdp.basePath,
      reader: {
        async checkPolicy() {
          return "DENY";
        },
      },
    });
    const wallet = await adapter.createWallet("worker-1");
    assert.equal(wallet.address, SMART);
    assert.equal(wallet.provider, "agentkit");
    assert.equal(await adapter.checkPolicy(SPEND), "DENY");
  } finally {
    await cdp.close();
  }
});

test("CDP adapter without a reader refuses to guess a verdict", () => {
  const adapter = createCdpWalletAdapter({ name: "worker-1" });
  assert.throws(() => adapter.checkPolicy(SPEND), /No PolicyReader bound/);
});

test("CDP adapter needs an account name", async () => {
  const adapter = createCdpWalletAdapter({});
  await assert.rejects(() => adapter.createWallet(), /needs an account name/);
});
