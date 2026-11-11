/**
 * The chain client naming the rule behind a denied propose, by view calls.
 *
 * The transport is a stub that answers `eth_call` per contract address, so each
 * module answers `check` and its own getters and nothing else, the way a
 * deployed one does. Nothing is broadcast.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ANVIL_CHAIN_ID,
  escalationRouterAbi,
  getAddresses,
  policyModuleAbi,
  policyStackAbi,
  spendCapPolicyAbi,
  timeWindowPolicyAbi,
  whitelistPolicyAbi,
} from "@lacrew/core";
import { createOnchainClient } from "./onchain.js";
import {
  PolicyDeniedError,
  describePolicyDenial,
  policyDenialOf,
  POLICY_DENIED_ERROR,
} from "./policyDenial.js";

type Address = `0x${string}`;
const named = (byte: string): Address => `0x${byte.repeat(20)}` as Address;

/** Anvil account 0: signing only. */
const MAIN = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const WORKER = named("c3");
const TARGET = named("e5");
const STRANGER = named("d4");
const ZERO = named("00");
const WHITELIST = named("a1");
const WINDOW = named("a2");
const CAP = named("a3");
const OPAQUE = named("a4");
const STACK = named("b1");
const INNER = named("b2");

const ALLOW = 0;
const ESCALATE = 1;
const DENY = 2;
/** 80 000 seconds into its UTC day. */
const NOW = 1_700_000_000;

type Module =
  | { kind: "stack"; members: Address[] }
  | { kind: "whitelist"; allowed: Address[] }
  | { kind: "time_window"; start: number; end: number }
  | { kind: "spend_cap"; cap: bigint }
  /** Answers `check` and has no getter this client knows. */
  | { kind: "opaque"; verdict: number };

interface Chain {
  /** The router's default policy. */
  policy: Address;
  policyOf?: Record<Address, Address>;
  modules: Record<Address, Module>;
  /** Every `eth_call`, as `<to>.<function>`. */
  calls?: string[];
}

function verdictOf(chain: Chain, address: Address, target: Address, value: bigint): number {
  const module = chain.modules[address];
  if (!module) throw new Error("no code");
  switch (module.kind) {
    case "stack": {
      let escalate = false;
      for (const member of module.members) {
        const verdict = verdictOf(chain, member, target, value);
        if (verdict === DENY) return DENY;
        if (verdict === ESCALATE) escalate = true;
      }
      return escalate ? ESCALATE : ALLOW;
    }
    case "whitelist":
      return module.allowed.includes(target) ? ALLOW : DENY;
    case "time_window": {
      const tod = NOW % 86_400;
      return tod < module.start || tod >= module.end ? DENY : ALLOW;
    }
    case "spend_cap":
      return value <= module.cap ? ALLOW : ESCALATE;
    case "opaque":
      return module.verdict;
  }
}

const GETTERS: Record<Module["kind"], Abi | null> = {
  stack: policyStackAbi as Abi,
  whitelist: whitelistPolicyAbi as Abi,
  time_window: timeWindowPolicyAbi as Abi,
  spend_cap: spendCapPolicyAbi as Abi,
  opaque: null,
};

const reverted = (data: Hex = "0x") =>
  Object.assign(new Error("execution reverted"), { code: 3, data });

function answer(chain: Chain, to: Address, data: Hex): Hex {
  const router = getAddresses(ANVIL_CHAIN_ID).escalationRouter.toLowerCase();
  if (to.toLowerCase() === router) {
    const call = decodeFunctionData({ abi: escalationRouterAbi, data });
    chain.calls?.push(`router.${call.functionName}`);
    const result = (value: unknown) =>
      encodeFunctionResult({
        abi: escalationRouterAbi,
        functionName: call.functionName,
        result: value,
      } as never);
    if (call.functionName === "policy") return result(chain.policy);
    if (call.functionName === "policyOf") {
      const [node] = call.args as readonly [Address];
      return result(chain.policyOf?.[node.toLowerCase() as Address] ?? ZERO);
    }
    if (call.functionName === "propose") {
      const [agent, target, value] = call.args as readonly [Address, Address, bigint, Hex];
      const policy = chain.policyOf?.[agent.toLowerCase() as Address] ?? chain.policy;
      const verdict = verdictOf(chain, policy, target.toLowerCase() as Address, value);
      if (verdict === DENY) {
        throw reverted(
          encodeErrorResult({
            abi: escalationRouterAbi,
            errorName: "UnexpectedVerdict",
            args: [DENY],
          }),
        );
      }
      // Any other revert the router has, to show it is left alone.
      throw reverted(
        encodeErrorResult({ abi: escalationRouterAbi, errorName: "NoApprover", args: [agent] }),
      );
    }
    throw reverted();
  }

  const address = to.toLowerCase() as Address;
  const module = chain.modules[address];
  if (!module) throw reverted();
  try {
    const call = decodeFunctionData({ abi: policyModuleAbi, data });
    if (call.functionName === "check") {
      const [, target, value] = call.args as readonly [Address, Address, bigint, Hex];
      chain.calls?.push(`${address}.check`);
      return encodeFunctionResult({
        abi: policyModuleAbi,
        functionName: "check",
        result: verdictOf(chain, address, target.toLowerCase() as Address, value),
      } as never);
    }
  } catch (err) {
    if ((err as { code?: number }).code === 3) throw err;
  }
  const abi = GETTERS[module.kind];
  if (!abi) throw reverted();
  let call: { functionName: string; args?: readonly unknown[] };
  try {
    call = decodeFunctionData({ abi, data });
  } catch {
    // A getter of another kind of module: no such function here.
    throw reverted();
  }
  chain.calls?.push(`${address}.${call.functionName}`);
  const result = (value: unknown) =>
    encodeFunctionResult({ abi, functionName: call.functionName, result: value } as never);
  if (module.kind === "stack") {
    if (call.functionName === "moduleCount") return result(BigInt(module.members.length));
    if (call.functionName === "modules") return result(module.members[Number(call.args![0])]);
  }
  if (module.kind === "whitelist" && call.functionName === "allowed") {
    return result(module.allowed.includes((call.args![0] as string).toLowerCase() as Address));
  }
  if (module.kind === "time_window") {
    if (call.functionName === "startSecondOfDay") return result(module.start);
    if (call.functionName === "endSecondOfDay") return result(module.end);
  }
  if (module.kind === "spend_cap" && call.functionName === "defaultCap") {
    return result(module.cap);
  }
  throw reverted();
}

function clientOn(chain: Chain) {
  return createOnchainClient({
    // No retries: a stubbed revert is final, as a node's own is.
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          switch (method) {
            case "eth_chainId":
              return `0x${ANVIL_CHAIN_ID.toString(16)}`;
            case "eth_getBlockByNumber":
              return { number: "0x1", timestamp: `0x${NOW.toString(16)}` };
            case "eth_call": {
              const { to, data } = (params as Array<{ to: Address; data: Hex }>)[0]!;
              return answer(chain, to, data);
            }
            default:
              throw new Error(`unstubbed rpc: ${method}`);
          }
        },
      },
      { retryCount: 0 },
    ),
    account: MAIN,
    chainId: ANVIL_CHAIN_ID,
    addresses: getAddresses(ANVIL_CHAIN_ID),
  });
}

const MODULES: Chain["modules"] = {
  [WHITELIST]: { kind: "whitelist", allowed: [TARGET] },
  [WINDOW]: { kind: "time_window", start: 0, end: 3_600 },
  [CAP]: { kind: "spend_cap", cap: 50n },
  [OPAQUE]: { kind: "opaque", verdict: DENY },
};

const denied = async (run: Promise<unknown>) => {
  const err = await run.then(
    () => assert.fail("the propose was not denied"),
    (caught: unknown) => caught,
  );
  assert.ok(err instanceof PolicyDeniedError, String(err));
  assert.equal(err.errorName, "UnexpectedVerdict");
  assert.equal(err.verdict, "DENY");
  assert.ok(err.cause, "the chain's own revert is kept as the cause");
  assert.equal(policyDenialOf(err), err.denial);
  return err;
};

describe("onchain client: a denied propose names its rule", () => {
  it("names the allowlist behind the default stack", async () => {
    const chain: Chain = {
      policy: STACK,
      modules: { ...MODULES, [STACK]: { kind: "stack", members: [CAP, WHITELIST] } },
    };
    const client = clientOn(chain);
    const input = { agent: WORKER, target: STRANGER, value: 1n };
    const err = await denied(client.proposeIntent(input));
    assert.deepEqual(err.denial, {
      module: getAddress(WHITELIST),
      kind: "whitelist",
      reason: "target_not_allowlisted",
      detail: `Target ${STRANGER} is not on the allowlist.`,
      target: STRANGER,
    });
    assert.match(err.message, /^UnexpectedVerdict: denied by the whitelist policy 0xa1a1/i);
    // The same answer without proposing, and none where nothing denies.
    assert.deepEqual(await client.explainDenial(input), err.denial);
    assert.equal(await client.explainDenial({ ...input, target: TARGET }), null);
    assert.equal(
      await client.explainDenial({ ...input, target: TARGET, value: 51n }),
      null,
      "an escalation is not a denial",
    );
  });

  it("reads the node's own stack, looks into a nested one, and reports the window", async () => {
    const chain: Chain = {
      policy: WHITELIST,
      policyOf: { [WORKER]: STACK },
      modules: {
        ...MODULES,
        [STACK]: { kind: "stack", members: [CAP, INNER] },
        [INNER]: { kind: "stack", members: [WHITELIST, WINDOW] },
      },
      calls: [],
    };
    const err = await denied(
      clientOn(chain).proposeIntent({ agent: WORKER, target: TARGET, value: 1n }),
    );
    assert.deepEqual(err.denial, {
      module: getAddress(WINDOW),
      kind: "time_window",
      reason: "outside_time_window",
      detail: "Outside the allowed time window (00:00-01:00 UTC; the ledger's clock reads 22:13).",
      startSecondOfDay: 0,
      endSecondOfDay: 3_600,
      secondOfDay: 80_000,
    });
    // Only view calls followed the dry run: nothing was sent.
    assert.equal(chain.calls![0], "router.propose");
    assert.ok(chain.calls!.every((call, i) => i === 0 || call !== "router.propose"));
  });

  it("names the first module to deny when two would", async () => {
    const chain: Chain = {
      policy: STACK,
      modules: { ...MODULES, [STACK]: { kind: "stack", members: [WINDOW, WHITELIST] } },
    };
    const err = await denied(
      clientOn(chain).proposeIntent({ agent: WORKER, target: STRANGER, value: 1n }),
    );
    assert.equal(err.denial?.module, getAddress(WINDOW));
  });

  it("reports a module it cannot classify as denying, without guessing its rule", async () => {
    const chain: Chain = {
      policy: STACK,
      modules: { ...MODULES, [STACK]: { kind: "stack", members: [CAP, OPAQUE] } },
    };
    const err = await denied(
      clientOn(chain).proposeIntent({ agent: WORKER, target: TARGET, value: 1n }),
    );
    assert.deepEqual(err.denial, {
      module: getAddress(OPAQUE),
      kind: "unknown",
      reason: "policy_denied",
      detail: "A policy module of an unrecognised kind denied this action.",
    });
  });

  it("still reports the denial when the module cannot be found afterwards", async () => {
    // The stack denies on the dry run and its members cannot be enumerated.
    const chain: Chain = {
      policy: STACK,
      modules: { ...MODULES, [STACK]: { kind: "stack", members: [named("ee")] } },
    };
    chain.modules[STACK] = { kind: "opaque", verdict: DENY };
    const client = clientOn(chain);
    const broken = Object.assign(client, {
      explainDenial: async () => {
        throw new Error("rpc down");
      },
    });
    const err = await denied(broken.proposeIntent({ agent: WORKER, target: TARGET, value: 1n }));
    assert.equal(err.denial, null);
    assert.equal(err.message, "UnexpectedVerdict: denied by policy");
  });

  it("leaves every other revert as the chain raised it", async () => {
    const chain: Chain = { policy: WHITELIST, modules: MODULES };
    const err = await clientOn(chain)
      .proposeIntent({ agent: WORKER, target: TARGET, value: 1n })
      .catch((caught: unknown) => caught);
    assert.ok(!(err instanceof PolicyDeniedError));
    assert.match(String((err as Error).message), /NoApprover/);
    assert.equal(policyDenialOf(err), undefined);
  });
});

describe("describePolicyDenial", () => {
  it("names a rule only for the kinds that deny by one", () => {
    assert.equal(POLICY_DENIED_ERROR, "UnexpectedVerdict");
    const of = (kind: Parameters<typeof describePolicyDenial>[0]["kind"]) =>
      describePolicyDenial({ address: OPAQUE, kind, target: TARGET });
    assert.equal(of("whitelist").reason, "target_not_allowlisted");
    assert.equal(of("time_window").reason, "outside_time_window");
    assert.equal(of("time_window").detail, "Outside the allowed time window.");
    for (const kind of ["spend_cap", "rate_limit", "stack", "unknown"] as const) {
      assert.equal(of(kind).reason, "policy_denied", kind);
    }
    assert.equal(of("rate_limit").detail, "The rate limit policy denied this action.");
  });
});
