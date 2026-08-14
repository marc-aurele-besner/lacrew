---
title: "Wallets"
---

An agent seat needs an address that can hold and spend funds. LaCrew does not
issue one. Wallet infrastructure is a solved, competitive problem, and the part
that is ours — who may spend what, on whose approval — is onchain and provider
independent. So every wallet provider sits behind one interface, and feature
code depends on that interface rather than on any vendor's SDK.

```ts
export interface WalletAdapter {
  readonly provider: string;
  createWallet(label?: string): Promise<{ address: `0x${string}`; provider: string }>;
  checkPolicy(input: AdapterCheckInput): Verdict | Promise<Verdict>;
}
```

Four providers implement it today: **Coinbase CDP / AgentKit**, **Safe**,
**MetaMask smart accounts**, and **GOAT**. They are peers. None of them is the
default, and hard-wiring one into feature code is a design defect, not a
shortcut.

## The two rules every adapter keeps

**A verdict comes from the chain or it is an error.** `checkPolicy` is a
preflight against the deployed `IPolicyModule` stack, read through a
`PolicyReader`. An adapter built without one **refuses** — it does not fall back
to a cap heuristic. The reason is that a `Verdict` carries nothing saying where
it came from: an ALLOW from a guess is indistinguishable from permission the
chain actually granted, and the guess is the one that will be believed. For the
same reason, a reader that cannot reach its RPC surfaces the failure instead of
reading as ALLOW.

The preflight is advisory. Enforcement stays onchain at propose time; the
preflight exists so an agent finds out before it spends gas learning from a
revert.

**No adapter holds key material.** Each takes a signer or a client from the
caller and returns transactions rather than broadcasting them. Nothing in this
repo can move funds on its own.

Both rules are asserted by a shared conformance suite,
`@lacrew/adapter-wallet-agentkit/contract`, which every adapter's tests run
against itself.

## Choosing one

| Provider         | Package                           | Reach for it when                                                                                                                                                                                                                                                                              |
| ---------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coinbase CDP** | `@lacrew/adapter-wallet-agentkit` | You want wallets provisioned and their keys held by a managed service, addressed by name. Seats appear without anybody handling a private key. Costs an account and an API credential; the keys are Coinbase's to hold.                                                                        |
| **Safe**         | `@lacrew/adapter-wallet-safe`     | The seat's own spending should need more than one signature, or you want the treasury and the seats on the same, widely reviewed multisig. Counterfactual addresses can be funded before deployment; the AllowanceModule gives an agent a capped, revocable spending lane. Heaviest to set up. |
| **MetaMask**     | `@lacrew/adapter-wallet-metamask` | You want session keys with no bundler: a delegation is capped, expiring and revocable, redeemed by the delegate with a **plain transaction**, so an autonomous agent needs no ERC-4337 infrastructure. Base and Base Sepolia today.                                                            |
| **GOAT**         | `@lacrew/adapter-wallet-goat`     | The crew already runs on GOAT's tools — swaps, transfers, plugin actions — and you want those tools bounded by the org's policy stack rather than by whatever the plugin decides.                                                                                                              |

If none of that decides it: CDP is the least setup, Safe is the most control,
MetaMask is the best fit for long-running unattended agents, and GOAT is the one
you pick because of the tools, not because of the wallet.

## Selecting a provider

One environment variable, read by `@lacrew/orchestrator`:

```bash
LACREW_WALLET_ADAPTER=goat   # agentkit · safe · metamask · goat
```

Unset means the deployment provisions no seat wallets, which is a valid
configuration. A **name the orchestrator does not recognise is an error**, never
a fallback to a default — an unrecognised provider quietly becoming `agentkit`
would move real funds through a wallet nobody chose.

```ts
import { walletAdapterFromEnv } from "@lacrew/orchestrator";

const adapter = await walletAdapterFromEnv({ reader, ...providerOptions });
```

The adapter package is imported only when its id is selected, so a Safe
deployment never loads GOAT's optional peer, or the reverse.

## GOAT

GOAT ("Great Onchain Agent Toolkit") is a toolkit, not a custody service. It
hands an agent a wallet client and a set of tools that call it, so a spend
leaves through `sendTransaction` on that client.

That shape makes the integration two-sided.

**The seat.** A GOAT client _is_ one account — there is no counterfactual
factory behind it, so unlike Safe and MetaMask the `label` on `createWallet()`
does not derive an address. One adapter describes one seat; build a second
adapter over a second client.

```ts
import { createGoatWalletAdapterFromViem } from "@lacrew/adapter-wallet-goat";

const adapter = await createGoatWalletAdapterFromViem({ client: walletClient, reader });
const seat = await adapter.createWallet(); // { address, provider: "goat" }
```

`@goat-sdk/wallet-viem` is an **optional peer**: install it only if you use this
provider. A viem client with no account is refused here rather than at the first
send, because GOAT's own `getAddress()` returns the empty string instead of
failing — an empty seat is the one thing a wallet adapter must never hand back
as though it were funded.

**The gate.** Putting the policy stack in front of `sendTransaction` bounds
every GOAT tool at once, shipped and unshipped, without LaCrew knowing what any
of them do:

```ts
import { gateGoatWallet, GoatPolicyError } from "@lacrew/adapter-wallet-goat";

const wallet = gateGoatWallet({ wallet: goatClient, reader, onBlocked: openEscalation });
// hand `wallet` to GOAT's getTools() instead of the raw client
```

An ALLOW sends exactly what was asked. DENY and ESCALATE throw
`GoatPolicyError` carrying the verdict, and nothing is broadcast.

The gate encodes `abi` + `functionName` + `args` before checking, because GOAT
tools mostly describe a call that way. Checking such a request against `0x`
would ask the policy stack about a plain transfer, and a whitelist or
selector-aware module would then judge something the agent is not about to do. A
call naming a function with no ABI to encode is refused for the same reason.

### Version pin

Verified against `@goat-sdk/wallet-viem@0.3.0` (`@goat-sdk/core@0.5.0`). Two of
its peer ranges are behind this workspace and pnpm reports them as unmet:
`viem@2.23.4` exactly, and `zod@^3`. The wallet-client path used here works on
the newer versions of both — `packages/adapters/wallet-goat/src/index.test.ts`
exercises the real `viem()` client rather than only a fake, so a break in that
path fails the suite instead of surfacing in production. If you pin GOAT's
versions exactly, expect a second copy of `viem` in the tree.

## Out of scope for now

- EIP-7702 in-place EOA upgrade (verified viable, not wired).
- Chains beyond those each provider lists above.
- Streaming budgets and passkey owners on the MetaMask delegation path.
