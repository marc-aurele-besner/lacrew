import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { http } from "viem";
import { CrewRuntime, createRuntimeFromEnv } from "./runtime.js";
import {
  ADDRESS_ENV_VARS,
  ANVIL_CHAIN_ID,
  MOCK_WORKER,
  type AgentWallet,
  type ChainAddresses,
  type PolicyModuleInfo,
  type WatchedChain,
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

  it("narrows an under-cap spend once the agent's rate allowance is spent", async () => {
    // The value is inside the cap, so the cap alone would allow it — but a live
    // rate window with nothing left escalates, and any ESCALATE dominates.
    const nowSec = Math.floor(Date.now() / 1000);
    const runtime = new CrewRuntime({
      client: policyReadingClient({
        modules: [
          ...CAP_50,
          {
            address: "0x00000000000000000000000000000000000000ra",
            kind: "rate_limit",
            maxActions: 10,
            windowSeconds: 3600,
            windowStartSec: nowSec - 600,
            actionsUsed: 10,
          },
        ],
      }),
    });
    assert.deepEqual(await runtime.scopesForSpend(AGENT, 10n), ["propose:intent"]);
  });

  it("keeps the full set when the rate window is about to lapse", async () => {
    // Under 60s left: the propose could be mined after the reset, and a narrowed
    // key would revert a call the policy allows by then.
    const nowSec = Math.floor(Date.now() / 1000);
    const runtime = new CrewRuntime({
      client: policyReadingClient({
        modules: [
          {
            address: "0x00000000000000000000000000000000000000ra",
            kind: "rate_limit",
            maxActions: 10,
            windowSeconds: 3600,
            windowStartSec: nowSec - 3580,
            actionsUsed: 10,
          },
        ],
      }),
    });
    assert.equal((await runtime.scopesForSpend(AGENT, 10n)).length, 2);
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

describe("getAgentWallets", () => {
  it("returns no chain entry in mock mode rather than empty wallets on a chain", () => {
    // "No chain answered" and "the accounts hold nothing" are different
    // answers. The second is a chain entry whose wallets read zero; reporting
    // it here would tell an operator their agents are broke when in fact
    // nothing was read.
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    return runtime.getAgentWallets().then((chains) => assert.deepEqual(chains, []));
  });

  it("labels the chain it read from, and reports nulls for an unknown one", async () => {
    const addr = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
    const wallet: AgentWallet = {
      account: addr("b"),
      kind: "worker_agent",
      active: true,
      native: { symbol: "ETH", token: "native", decimals: 18, balance: 5n * 10n ** 17n },
      tokens: [{ symbol: "USDC", token: addr("6"), decimals: 6, balance: 25_000_000n }],
    };

    const build = (chainId: number) => {
      const addresses: ChainAddresses = {
        chainId,
        orgRegistry: addr("1"),
        treasury: addr("2"),
        escalationRouter: addr("3"),
        governanceModule: addr("4"),
        spendCapPolicy: addr("5"),
        mockUSDC: addr("6"),
      };
      const client = createOnchainClient({
        // Never dialed: the balance read is stubbed so this exercises the
        // chain envelope the runtime wraps around it.
        transport: http("http://127.0.0.1:1"),
        chainId,
        addresses,
      });
      client.getAgentBalances = async () => [wallet];
      return new CrewRuntime({
        client,
        mode: "onchain",
        chainId,
        workerAgent: addr("b"),
        managerAgent: addr("c"),
        spendTarget: addr("d"),
      });
    };

    const [anvil, ...rest] = await build(ANVIL_CHAIN_ID).getAgentWallets();
    assert.equal(rest.length, 0, "one client reads one chain");
    assert.equal(anvil?.chainId, ANVIL_CHAIN_ID);
    assert.equal(anvil?.chainName, "Anvil (local)");
    assert.equal(anvil?.nativeSymbol, "ETH");
    assert.deepEqual(anvil?.wallets, [wallet]);

    // Polygon settles in POL, and the catalog now says so — the case that
    // proves the coin symbol is per-chain data rather than a default.
    const [polygon] = await build(137).getAgentWallets();
    assert.equal(polygon?.chainName, "Polygon");
    assert.equal(polygon?.nativeSymbol, "POL");

    // A chain nothing names reports nulls rather than stamping "ETH" on a
    // balance denominated in something else.
    const [unknown] = await build(999_999).getAgentWallets();
    assert.equal(unknown?.chainId, 999_999);
    assert.equal(unknown?.chainName, null);
    assert.equal(unknown?.nativeSymbol, null);
  });
});

describe("watched chains", () => {
  const addr = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;

  function build(watchlist: WatchedChain[]) {
    const addresses: ChainAddresses = {
      chainId: ANVIL_CHAIN_ID,
      orgRegistry: addr("1"),
      treasury: addr("2"),
      escalationRouter: addr("3"),
      governanceModule: addr("4"),
      spendCapPolicy: addr("5"),
      mockUSDC: addr("6"),
    };
    const client = createOnchainClient({
      transport: http("http://127.0.0.1:1"),
      chainId: ANVIL_CHAIN_ID,
      addresses,
    });
    client.getAgentBalances = async () => [];
    client.getOrgTree = async () => [
      { account: addr("b"), kind: "worker_agent", parent: null, active: true },
    ];
    return new CrewRuntime({
      client,
      mode: "onchain",
      chainId: ANVIL_CHAIN_ID,
      watchlist,
      workerAgent: addr("b"),
      managerAgent: addr("c"),
      spendTarget: addr("d"),
    });
  }

  it("reports a watched chain with no endpoint as unread, never as empty wallets", async () => {
    // The property the whole feature turns on. Rendering [] as "these accounts
    // hold nothing" would put a fabricated zero on a balance screen.
    const chains = await build([{ chainId: 8453, tokens: [] }]).getAgentWallets();
    const base = chains.find((c) => c.chainId === 8453)!;
    assert.equal(base.read, false);
    assert.equal(base.reason, "no_rpc");
    assert.deepEqual(base.wallets, []);
    assert.equal(base.chainName, "Base", "an unread chain is still named");
  });

  it("reports an unreachable endpoint as unread, with the reason", async () => {
    const chains = await build([
      // Port 1 refuses; nothing is listening and nothing will be.
      { chainId: 8453, rpcUrl: "http://127.0.0.1:1", tokens: [] },
    ]).getAgentWallets();
    const base = chains.find((c) => c.chainId === 8453)!;
    assert.equal(base.read, false);
    assert.equal(base.reason, "unreachable");
    assert.ok(base.detail, "an operator has to be able to fix it");
    assert.deepEqual(base.wallets, []);
  });

  it("always reports the bound chain as read", async () => {
    const chains = await build([{ chainId: 999, tokens: [] }]).getAgentWallets();
    const bound = chains.find((c) => c.chainId === ANVIL_CHAIN_ID)!;
    assert.equal(bound.read, true);
    // An unnameable watched chain still gets a row — watching it is the fact.
    const unknown = chains.find((c) => c.chainId === 999)!;
    assert.equal(unknown.chainName, null);
    assert.equal(unknown.read, false);
  });

  it("does not open a second connection for the chain it is already on", async () => {
    // The bound chain's watched tokens ride the existing read; a duplicate
    // entry would render the chain twice with two different token lists.
    const chains = await build([{ chainId: ANVIL_CHAIN_ID, tokens: [] }]).getAgentWallets();
    assert.equal(chains.filter((c) => c.chainId === ANVIL_CHAIN_ID).length, 1);
    assert.equal(chains.length, 1);
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
  /* ——— standing agent controls (F1.7) ——— */

  it("a pause revokes the live key, not just the next one", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const session = await runtime.boot(MOCK_WORKER);
    assert.equal(session.revoked, false);

    const result = await runtime.pauseAgent(MOCK_WORKER, "spending anomaly");
    assert.equal(result.paused, true);
    // Gating issuance alone would leave a key minted a minute ago working
    // until it expired — which is precisely the key an operator is reaching
    // for the pause to take away.
    assert.deepEqual(result.failed, []);

    // Booting again must mint a fresh key rather than return the cached one:
    // the key that existed before the pause can no longer sign.
    runtime.resumeAgent(MOCK_WORKER);
    const after = await runtime.boot(MOCK_WORKER);
    assert.notEqual(after.keyId, session.keyId);
  });

  it("a paused agent cannot boot, and can again once resumed", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    await runtime.pauseAgent(MOCK_WORKER);
    assert.equal(runtime.isAgentPaused(MOCK_WORKER), true);
    await assert.rejects(() => runtime.boot(MOCK_WORKER), /agent_paused/);

    runtime.resumeAgent(MOCK_WORKER);
    assert.equal(runtime.isAgentPaused(MOCK_WORKER), false);
    const session = await runtime.boot(MOCK_WORKER);
    assert.equal(session.revoked, false);
  });

  it("resuming issues nothing — the revoked key stays revoked", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const before = await runtime.boot(MOCK_WORKER);
    await runtime.pauseAgent(MOCK_WORKER);
    runtime.resumeAgent(MOCK_WORKER);

    const after = await runtime.boot(MOCK_WORKER);
    // Handing the old key back would undo the revocation the pause performed.
    assert.notEqual(after.keyId, before.keyId);
  });

  it("pausing writes who decided it and why; a redundant pause writes nothing", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    await runtime.pauseAgent(MOCK_WORKER, "spending anomaly");
    await runtime.pauseAgent(MOCK_WORKER, "again");

    const events = (await runtime.audit()).filter((e) => e.type === "AgentPaused");
    assert.equal(events.length, 1);
    assert.equal((events[0]?.payload as { reason?: string }).reason, "spending anomaly");
  });

  it("a pause raises no governance action — it is not an onchain change", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const before = (await runtime.audit()).filter((e) => e.type.startsWith("Proposal")).length;
    await runtime.pauseAgent(MOCK_WORKER, "spending anomaly");
    // The agent keeps its seat, its grant and its reporting line. A pause is
    // the orchestrator refusing to mint keys, so nothing proposes.
    const after = (await runtime.audit()).filter((e) => e.type.startsWith("Proposal")).length;
    assert.equal(after, before);
  });

  it("an agent's brief becomes its system prompt, identity line first", () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.equal(
      runtime.systemPromptFor(MOCK_WORKER),
      `You are agent ${MOCK_WORKER} in a LaCrew organization.`,
    );

    runtime.setAgentBrief(MOCK_WORKER, [
      { label: "crew:Trading", text: "Quote before you fill." },
      { label: "agent", text: "You settle; you do not price." },
    ]);
    const prompt = runtime.systemPromptFor(MOCK_WORKER);
    assert.ok(prompt.startsWith(`You are agent ${MOCK_WORKER} in a LaCrew organization.`));
    assert.match(prompt, /Quote before you fill\./);
  });
  it("records a directive change as shape, never as instruction text", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    runtime.setAgentBrief(MOCK_WORKER, [
      {
        label: "crew:github-experts",
        text: "Never merge a PR that touches CI workflows.",
        resources: [
          { kind: "repo", ref: "owner/one" },
          { kind: "repo", ref: "owner/two" },
        ],
        skills: [{ name: "Triage", instructions: "classify it" }],
      },
      { label: "agent", text: "You watch; you do not merge." },
    ]);

    const events = (await runtime.audit()).filter((e) => e.type === "AgentDirectiveChanged");
    assert.equal(events.length, 1);
    const payload = events[0]!.payload as Record<string, unknown>;
    assert.deepEqual(payload.layers, ["crew:github-experts", "agent"]);
    assert.equal(payload.resources, 2);
    assert.equal(payload.skills, 1);
    assert.equal(payload.cleared, false);

    // The trail is a bounded ring and a directive runs to thousands of
    // characters; the text is served in full by the controls endpoint instead.
    const serialised = JSON.stringify(payload);
    assert.equal(serialised.includes("Never merge a PR"), false);
    assert.equal(serialised.includes("You watch"), false);
  });

  it("records what the directive was before, so a rewrite is legible", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    runtime.setAgentBrief(MOCK_WORKER, [{ label: "agent", text: "first" }]);
    runtime.setAgentBrief(MOCK_WORKER, [
      { label: "crew:x", text: "crew rules" },
      { label: "agent", text: "second" },
    ]);

    const events = (await runtime.audit()).filter((e) => e.type === "AgentDirectiveChanged");
    assert.equal(events.length, 2);
    const second = events.find(
      (e) => (e.payload as { layers: string[] }).layers.length === 2,
    )!;
    assert.deepEqual((second.payload as { previousLayers: string[] }).previousLayers, ["agent"]);
  });

  it("marks a cleared directive as cleared rather than as an empty change", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    runtime.setAgentBrief(MOCK_WORKER, [{ label: "agent", text: "something" }]);
    runtime.setAgentBrief(MOCK_WORKER, []);

    // audit() serves newest first, so the clear is the head of the list.
    const events = (await runtime.audit()).filter((e) => e.type === "AgentDirectiveChanged");
    assert.equal(events.length, 2, "both writes are recorded, not collapsed");
    const latest = events[0]!;
    assert.equal((latest.payload as { cleared: boolean }).cleared, true);
    assert.deepEqual((latest.payload as { previousLayers: string[] }).previousLayers, ["agent"]);
  });

  it("writes no event when the directive was refused", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    // An event claiming a directive landed, for one that was rejected over the
    // ceiling, is worse than no event: the trail would assert a change nobody made.
    assert.throws(() =>
      runtime.setAgentBrief(MOCK_WORKER, [{ label: "agent", text: "x".repeat(20_000) }]),
    );
    const events = (await runtime.audit()).filter((e) => e.type === "AgentDirectiveChanged");
    assert.deepEqual(events, []);
  });
  it("keeps two same-millisecond off-chain events apart in the trail", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    // Off-chain events carry no intent id, tx hash or value, so the dedupe key
    // reduced to type + timestamp and collapsed these into one — the trail
    // asserting a single change where two had happened.
    runtime.setAgentBrief(MOCK_WORKER, [{ label: "agent", text: "one" }]);
    runtime.setAgentBrief(MOCK_WORKER, [{ label: "agent", text: "two" }]);

    const events = (await runtime.audit()).filter((e) => e.type === "AgentDirectiveChanged");
    assert.equal(events.length, 2);
    const seqs = events.map((e) => (e.payload as { seq: number }).seq);
    assert.equal(new Set(seqs).size, 2, "each event carries its own sequence");
  });
});
