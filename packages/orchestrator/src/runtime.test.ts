import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { http } from "viem";
import { CrewRuntime, createRuntimeFromEnv } from "./runtime.js";
import {
  ADDRESS_ENV_VARS,
  ANVIL_CHAIN_ID,
  MOCK_WORKER,
  type ChainAddresses,
  type PolicyModuleInfo,
} from "@lacrew/core";
import { createOnchainClient } from "@lacrew/sdk";
import { createLacrewClient } from "@lacrew/sdk/testing";

describe("CrewRuntime", () => {
  it("lists pending mock intents after construct", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const pending = await runtime.listPending();
    assert.ok(Array.isArray(pending));
    assert.ok(pending.length >= 1);
  });

  it("defaults to mock mode without ANVIL env", () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.equal(runtime.mode, "mock");
  });

  it("records local audit on mock tick and resolve", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const tick = await runtime.tick();
    assert.equal(tick.verdict, "ESCALATE");
    const afterTick = await runtime.audit();
    assert.ok(afterTick.some((e) => e.type === "IntentCreated" || e.type === "SessionIssued"));

    await runtime.resolve(tick.intentId, true);
    const afterResolve = await runtime.audit();
    assert.ok(afterResolve.some((e) => e.type === "IntentResolved"));
  });
});

/**
 * A client that reads as onchain (`publicClient` present) and answers the one
 * read the scope decision makes. Nothing here registers a session — the
 * decision is a read, and testing it needs no key.
 */
function policyReadingClient(opts: {
  modules: PolicyModuleInfo[];
  /** Collects the nodes each read asked about. */
  capturedNodes?: `0x${string}`[];
  throws?: boolean;
}) {
  const client = createLacrewClient({ useMock: true }) as unknown as Record<string, unknown>;
  return {
    ...client,
    publicClient: {},
    addresses: { chainId: ANVIL_CHAIN_ID },
    async getNodePolicies({ nodes }: { nodes?: `0x${string}`[] }) {
      if (opts.throws) throw new Error("rpc_unreachable");
      const node = nodes?.[0] ?? MOCK_WORKER;
      opts.capturedNodes?.push(node);
      return [{ node, policyModule: node, source: "node" as const, modules: opts.modules }];
    },
  } as unknown as ConstructorParameters<typeof CrewRuntime>[0]["client"];
}

describe("least-privilege session scopes", () => {
  const AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
  const CAP_50: PolicyModuleInfo[] = [
    {
      address: "0x00000000000000000000000000000000000000c1",
      kind: "spend_cap",
      cap: "50",
    },
  ];

  it("drops settlement authority from a spend the chain must escalate", async () => {
    // 75 > cap 50, so the router escalates and never reaches _requireSpendScope:
    // settlement authority on this key is authority the call cannot use.
    const runtime = new CrewRuntime({ client: policyReadingClient({ modules: CAP_50 }) });
    assert.deepEqual(await runtime.scopesForSpend(AGENT, 75n), ["propose:intent"]);
  });

  it("keeps settlement authority for a spend inside the cap", async () => {
    // This one can be ALLOWed and settled inline; a narrowed key would revert it.
    const runtime = new CrewRuntime({ client: policyReadingClient({ modules: CAP_50 }) });
    assert.equal((await runtime.scopesForSpend(AGENT, 10n)).length, 2);
  });

  it("keeps the full set when the stack holds no cap to prove anything with", async () => {
    const runtime = new CrewRuntime({ client: policyReadingClient({ modules: [] }) });
    assert.equal((await runtime.scopesForSpend(AGENT, 75n)).length, 2);
  });

  it("keeps the full set when the policy read fails", async () => {
    // An unreachable RPC must not narrow a key into an outage.
    const runtime = new CrewRuntime({
      client: policyReadingClient({ modules: CAP_50, throws: true }),
    });
    assert.equal((await runtime.scopesForSpend(AGENT, 75n)).length, 2);
  });

  it("narrows nothing on an off-chain client, which has no stack to read", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.equal((await runtime.scopesForSpend(AGENT, 75n)).length, 2);
  });

  it("reads the stack of the agent being spent for", async () => {
    // Only AGENT is capped here. Narrowing therefore proves the read was scoped
    // to the paying agent rather than to whatever node the client walks first —
    // reading another node's cap would narrow keys by someone else's limit.
    const asked: `0x${string}`[] = [];
    const runtime = new CrewRuntime({
      client: policyReadingClient({
        modules: CAP_50,
        capturedNodes: asked,
      }),
    });
    assert.deepEqual(await runtime.scopesForSpend(AGENT, 75n), ["propose:intent"]);
    assert.deepEqual(asked, [AGENT]);
  });

  it("reports the decision without changing the agent's standing policy", async () => {
    const runtime = new CrewRuntime({ client: policyReadingClient({ modules: CAP_50 }) });
    await runtime.scopesForSpend(AGENT, 75n);
    assert.equal((await runtime.scopesForSpend(AGENT, 10n)).length, 2);
  });
});

describe("session ceilings", () => {
  const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

  it("issues distinct sessions per limit set", async () => {
    // Reusing a cached wide key for a tighter-scoped run would hand back the
    // authority the ceiling exists to remove.
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const wide = await runtime.boot(A);
    const tight = await runtime.boot(A, { maxValue: 1_000n });
    assert.notEqual(wide.keyId, tight.keyId);

    // Same limits reuse the same session.
    const again = await runtime.boot(A, { maxValue: 1_000n });
    assert.equal(again.keyId, tight.keyId);
  });

  it("a per-run scope narrowing does not stick to the agent's policy", async () => {
    // A flow's scope narrows its own run's key, never the agent — otherwise the
    // next internal boot would inherit a scope the flow, not the operator, chose.
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const run = await runtime.boot(A, { scopes: ["propose:intent"], persistScopePolicy: false });
    assert.deepEqual(run.scopes, ["propose:intent"]);
    const later = await runtime.boot(A, {});
    assert.equal(later.scopes.length, 2, "a later boot gets the full default, not the narrowed set");
    assert.notEqual(run.keyId, later.keyId);
  });

  it("an operator's explicit narrowing does stick to the agent", async () => {
    // The default: a deliberate narrowing must persist, or internal boots re-widen it.
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    await runtime.boot(A, { scopes: ["propose:intent"] });
    const later = await runtime.boot(A, {});
    assert.deepEqual(later.scopes, ["propose:intent"]);
  });

  it("has no ceiling to derive without an onchain policy", async () => {
    // Mock mode has no SpendCapPolicy to read, so no ceiling can be claimed.
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.equal(await runtime.ceilingMaxValue(A, MOCK_WORKER), undefined);
  });

  it("treats a self-scoped flow as having no ceiling", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.equal(await runtime.ceilingMaxValue(A, A), undefined);
    assert.equal(await runtime.ceilingMaxValue(A, undefined), undefined);
  });
});

describe("listAssets", () => {
  it("returns [] in mock mode rather than inventing a stack list", () => {
    // The mock client models a single unnamed asset and holds no address
    // book; a fabricated list would drive a picker over stacks that do not
    // exist onchain.
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.deepEqual(runtime.listAssets(), []);
  });

  it("lists the address book's stacks, primary first, in onchain mode", () => {
    const addr = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
    const addresses: ChainAddresses = {
      chainId: ANVIL_CHAIN_ID,
      orgRegistry: addr("1"),
      treasury: addr("2"),
      escalationRouter: addr("3"),
      governanceModule: addr("4"),
      spendCapPolicy: addr("5"),
      mockUSDC: addr("6"),
      assets: [
        {
          symbol: "WETH",
          token: addr("7"),
          decimals: 18,
          treasury: addr("8"),
          escalationRouter: addr("9"),
          epochStreamer: addr("a"),
        },
      ],
    };
    const runtime = new CrewRuntime({
      client: createOnchainClient({
        // Never dialed: listAssets is a pure read of the address book.
        transport: http("http://127.0.0.1:1"),
        chainId: ANVIL_CHAIN_ID,
        addresses,
      }),
      mode: "onchain",
      chainId: ANVIL_CHAIN_ID,
      workerAgent: addr("b"),
      managerAgent: addr("c"),
      spendTarget: addr("d"),
    });
    const [primary, extra] = runtime.listAssets();
    assert.ok(primary && extra, "expected the primary stack plus one extra");
    assert.equal(primary.symbol, "USDC");
    assert.equal(primary.decimals, 6);
    assert.equal(primary.token, addresses.mockUSDC);
    assert.equal(extra.symbol, "WETH");
    assert.equal(extra.decimals, 18);
  });
});

describe("no demo address stands in for a real seat", () => {
  it("refuses an onchain runtime that names no seats", () => {
    // Left to default, the seats would be MOCK_WORKER / MOCK_MANAGER: the
    // runtime would sign as an agent the org never hired.
    assert.throws(
      () =>
        new CrewRuntime({
          client: createLacrewClient({ useMock: true }),
          mode: "onchain",
          chainId: ANVIL_CHAIN_ID,
        }),
      /workerAgent, managerAgent, spendTarget/,
    );
  });

  it("names only the seat that is missing", () => {
    assert.throws(
      () =>
        new CrewRuntime({
          client: createLacrewClient({ useMock: true }),
          mode: "onchain",
          chainId: ANVIL_CHAIN_ID,
          workerAgent: MOCK_WORKER,
          managerAgent: MOCK_WORKER,
        }),
      /^Error: An onchain CrewRuntime needs spendTarget;/,
    );
  });

  it("reports an address book with contracts but no seats", async () => {
    // A local chain described entirely through LACREW_* overrides: the
    // registry is named, the seats are not.
    const keys = ["ANVIL_RPC", "PRIVATE_KEY", "CHAIN_ID", ADDRESS_ENV_VARS.orgRegistry] as const;
    const restore = keys.map((k) => [k, process.env[k]] as const);
    // Unreachable on purpose: a seatless address book is a config gap, so it
    // must be reported without a chain round-trip.
    process.env.ANVIL_RPC = "http://127.0.0.1:1";
    process.env.PRIVATE_KEY = `0x${"1".repeat(64)}`;
    process.env.CHAIN_ID = "31338";
    process.env[ADDRESS_ENV_VARS.orgRegistry] = `0x${"ab".repeat(20)}`;
    try {
      const boot = await createRuntimeFromEnv();
      assert.equal(boot.ok, false);
      assert.equal(boot.ok === false && boot.reason, "incomplete_deployment");
      assert.match(boot.ok === false ? boot.detail : "", /worker, manager, x402Target/);
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
