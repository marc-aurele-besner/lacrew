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

Standard modules planned:

- Spend cap
- Contract whitelist
- Rate limit
- Time window
- Custom logic (third-party)

## TODO

- TODO: Spec module registry + upgrade path via GovernanceModule
- TODO: Publish ABI + abitype package for off-chain preflight
