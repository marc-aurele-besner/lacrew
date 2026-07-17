# IPolicyModule

The heart of the protocol. Modules stack on a node; first `DENY` wins; any `ESCALATE` routes upward.

```solidity
interface IPolicyModule {
    function check(
        address agent,
        address target,
        uint256 value,
        bytes calldata data
    ) external view returns (Verdict);
    // Verdict: ALLOW | ESCALATE | DENY
}
```

Standard modules (reference contracts):

| Module | Verdict behavior |
| --- | --- |
| `SpendCapPolicy` | ESCALATE over per-agent / default cap |
| `WhitelistPolicy` | DENY non-whitelisted targets |
| `RateLimitPolicy` | ESCALATE when window count ≥ max (router calls `record`) |
| `TimeWindowPolicy` | DENY outside daily UTC window |
| Custom | Third-party `IPolicyModule` implementations |

`PolicyStack` composes modules: **first DENY wins**; any ESCALATE is sticky; else ALLOW.

## TODO

- TODO: Per-node policy stacks (router still uses one global stack)
- TODO: Spec module registry + upgrade path via GovernanceModule
- TODO: Publish ABI + abitype package for off-chain preflight
