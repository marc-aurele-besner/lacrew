import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";
import { ANVIL_CHAIN_ID, type PolicyModuleInfo } from "@lacrew/core";
import { createLacrewClient } from "@lacrew/sdk/testing";
import type { PolicyModuleListing } from "@lacrew/flows";

/**
 * Attaching a bought policy module (PRD F3.1).
 *
 * The acceptance criterion is a negative one: buying a module and pressing
 * install must not change what an agent may do. So the assertions are about
 * what the runtime does *not* emit — no `setNodePolicy` call, only a proposal —
 * and about the stack it proposes: the modules the org already voted, in the
 * order they were voted, with the bought one appended. First DENY wins, so a
 * module on the end can only narrow; a module that replaced the stack could
 * sell a loosening as a guardrail.
 */

const NODE = "0x000000000000000000000000000000000000dEaD" as const;
const EXISTING_A = "0x00000000000000000000000000000000000000a1" as const;
const EXISTING_B = "0x00000000000000000000000000000000000000b2" as const;
const BOUGHT = "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318" as const;
const TIME_WINDOW = "0x00000000000000000000000000000000000000c1" as `0x${string}`;
const WHITELIST = "0x00000000000000000000000000000000000000d2" as `0x${string}`;

const listing: PolicyModuleListing = {
  id: "office-hours",
  version: "1.0.0",
  name: "Office hours",
  summary: "DENY outside 09:00–17:00 UTC.",
  deployments: [{ chainId: ANVIL_CHAIN_ID, address: BOUGHT }],
  slots: ["worker_agent"],
  audit: { status: "unaudited" },
};

type Calls = {
  deployed: `0x${string}`[][];
  proposed: Array<{ node: string; policyModule: string; tier?: string }>;
};

function attachingClient(opts: {
  modules?: PolicyModuleInfo[];
  /** Addresses the chain reports code at. Anything else reads as an EOA. */
  code?: `0x${string}`[];
  calls: Calls;
}) {
  const base = createLacrewClient({ useMock: true }) as unknown as Record<string, unknown>;
  const withCode = (opts.code ?? [BOUGHT, TIME_WINDOW, WHITELIST]).map((a) => a.toLowerCase());
  return {
    ...base,
    publicClient: {
      async getCode({ address }: { address: `0x${string}` }) {
        return withCode.includes(address.toLowerCase()) ? "0x60006000" : "0x";
      },
    },
    addresses: {
      chainId: ANVIL_CHAIN_ID,
      timeWindowPolicy: TIME_WINDOW,
      whitelistPolicy: WHITELIST,
    },
    async getNodePolicies({ nodes }: { nodes?: `0x${string}`[] }) {
      const node = nodes?.[0] ?? NODE;
      return [
        {
          node,
          policyModule: node,
          source: "node" as const,
          modules: opts.modules ?? [],
        },
      ];
    },
    async deployPolicyStack(members: `0x${string}`[]) {
      opts.calls.deployed.push(members);
      return { address: "0x00000000000000000000000000000000000000f0", txHash: "0xdead" };
    },
    async proposeSetNodePolicy(input: { node: string; policyModule: string; tier?: string }) {
      opts.calls.proposed.push(input);
      return { proposalId: "7", node: input.node, txHash: "0xbeef" };
    },
  } as unknown as ConstructorParameters<typeof CrewRuntime>[0]["client"];
}

const stack = (...addresses: `0x${string}`[]): PolicyModuleInfo[] =>
  addresses.map((address) => ({ address, kind: "unknown" as const }));

describe("attaching a marketplace policy module", () => {
  it("appends to the stack the chain binds and proposes the bind, high tier", async () => {
    const calls: Calls = { deployed: [], proposed: [] };
    const runtime = new CrewRuntime({
      client: attachingClient({ modules: stack(EXISTING_A, EXISTING_B), calls }),
    });

    const result = await runtime.proposeAttachPolicyModule({ node: NODE, listing });

    assert.deepEqual(result.members, [EXISTING_A, EXISTING_B, BOUGHT]);
    assert.deepEqual(calls.deployed, [[EXISTING_A, EXISTING_B, BOUGHT]]);
    assert.equal(calls.proposed.length, 1);
    assert.equal(calls.proposed[0]!.node, NODE);
    // Binding a module is constitutional, so it rides the high tier — a
    // marketplace purchase must not clear on a low-tier majority.
    assert.equal(calls.proposed[0]!.tier, "high");
    assert.equal(result.proposals[0]?.action, "setNodePolicy");
    assert.equal(result.proposals[0]?.proposalId, "7");
  });

  it("carries an inherited stack across rather than dropping it", async () => {
    // The node stands under the router default. Binding only the bought module
    // would take the org-wide stack off this node — a purchase that removed a
    // guardrail while claiming to add one.
    const calls: Calls = { deployed: [], proposed: [] };
    const client = attachingClient({ modules: stack(EXISTING_A), calls });
    (client as unknown as { getNodePolicies: unknown }).getNodePolicies = async () => [
      {
        node: NODE,
        policyModule: EXISTING_A,
        source: "default" as const,
        modules: stack(EXISTING_A),
      },
    ];
    const runtime = new CrewRuntime({ client });

    const result = await runtime.proposeAttachPolicyModule({ node: NODE, listing });
    assert.deepEqual(result.members, [EXISTING_A, BOUGHT]);
  });

  it("proposes nothing when the node already carries the module", async () => {
    const calls: Calls = { deployed: [], proposed: [] };
    const runtime = new CrewRuntime({
      client: attachingClient({ modules: stack(EXISTING_A, BOUGHT), calls }),
    });

    const result = await runtime.proposeAttachPolicyModule({ node: NODE, listing });
    assert.equal(result.alreadyBound, true);
    assert.deepEqual(result.proposals, []);
    // Nothing deployed either: a submit is a statement of intent, and an
    // identical stack has no intent left to state.
    assert.deepEqual(calls.deployed, []);
  });

  it("refuses a module with no code instead of stranding the node", async () => {
    const calls: Calls = { deployed: [], proposed: [] };
    const runtime = new CrewRuntime({ client: attachingClient({ code: [], calls }) });

    await assert.rejects(
      () => runtime.proposeAttachPolicyModule({ node: NODE, listing }),
      /policy_module_has_no_code/,
    );
    assert.deepEqual(calls.proposed, []);
  });

  it("refuses a listing that names no address on this chain", async () => {
    const calls: Calls = { deployed: [], proposed: [] };
    const runtime = new CrewRuntime({ client: attachingClient({ calls }) });

    await assert.rejects(
      () =>
        runtime.proposeAttachPolicyModule({
          node: NODE,
          listing: { ...listing, deployments: [{ chainId: 8453, address: BOUGHT }] },
        }),
      /policy_module_not_deployed_on_chain_31337/,
    );
  });

  it("refuses a payload that would not publish", async () => {
    const calls: Calls = { deployed: [], proposed: [] };
    const runtime = new CrewRuntime({ client: attachingClient({ calls }) });

    await assert.rejects(
      () => runtime.proposeAttachPolicyModule({ node: NODE, listing: { id: "x" } }),
      /invalid_policy_module_payload/,
    );
  });

  it("resolves a first-party listing against this deployment's own address book", async () => {
    const calls: Calls = { deployed: [], proposed: [] };
    const runtime = new CrewRuntime({ client: attachingClient({ calls }) });

    const result = await runtime.proposeAttachPolicyModule({
      node: NODE,
      listing: { ...listing, standardModule: "time_window", deployments: [] },
    });
    assert.equal(result.module, TIME_WINDOW);
    assert.deepEqual(result.members, [TIME_WINDOW]);
  });

  it("refuses without a chain rather than reporting a proposal nobody made", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    await assert.rejects(
      () => runtime.proposeAttachPolicyModule({ node: NODE, listing }),
      /policy_attach_requires_chain/,
    );
  });
});
