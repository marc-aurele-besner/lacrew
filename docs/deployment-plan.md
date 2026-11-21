# Contract deployment plan: testnet → mainnet (PRD F0.8 / F1.1 / F1.2 / F1.4)

How LaCrew's contracts get from Anvil to a public testnet and then to Base mainnet without
putting anyone's money at risk. This is a plan, not a runbook: each stage lists what must be
true to enter it, what happens in it, and the evidence that lets it exit. Nothing here has been
executed on a public network yet. As of this writing the only real deployment is `31337.json`.

## 1. What "deploying the contracts" means for LaCrew

Most protocols deploy one set of shared contracts. LaCrew doesn't, and the plan follows from that:

- **Every org is its own stack.** `OrgRegistry`, `GovernanceModule`, `Treasury`,
  `EscalationRouter`, the policy modules, `EpochStreamer` and `SessionRegistry` are deployed
  per org by that org's root: `deployOrg()` in `@lacrew/sdk` (`packages/sdk/src/deployOrg.ts`)
  or `lacrew deploy`. LaCrew never holds keys to a user's org, and there is no shared pool of
  user funds to drain.
- **Nothing is upgradeable.** No proxies, no proxy admin, no `upgradeTo`. Nobody can upgrade a
  live org. The flip side is that **a bug can't be patched in place**. The fix ships as a new
  version, and each org migrates by deploying a fresh stack and moving its treasury. That's why
  the audit gate (F1.2) is a hard gate, not a formality. The plan keeps contracts
  non-upgradeable on purpose. Adding proxies would bring back the admin key the design avoids.
- **What LaCrew itself puts on chain** is small:
  1. **Canonical, verified bytecode**: the exact release the SDK/CLI ships (`@lacrew/core`
     bytecode exports), with source verified on the block explorer so anyone can match an org's
     contracts to an audited release.
  2. **`MarketplacePayments`**: the one protocol-owned contract. It has a `governor` that can
     change `feeBps` and `feeRecipient`, so it needs real key management.
  3. **A reference org per chain**: the stack published as `deployments/<chainId>.json` that docs,
     examples and the cloud sandbox point at.
  4. **Testnet only: `MockUSDC` / `MockWETH`.** These must never reach mainnet (see §3).

So "safe deployment" splits into two problems: **(a) ship bytecode that's correct and provably
the audited bytecode**, and **(b) give the few protocol-owned addresses keys that can't be
lost or stolen through one laptop.**

## 2. Networks

| Stage             | Chain                   | Chain ID      | Purpose                                                       |
| ----------------- | ----------------------- | ------------- | ------------------------------------------------------------- |
| Local             | Anvil                   | 31337         | Dev loop, CI, conformance suite (works today)                 |
| Fork rehearsal    | Anvil `--fork-url` Base | 8453 (forked) | Real USDC, real Safe factories, real gas costs; no real funds |
| Public testnet #1 | Ethereum Sepolia        | 11155111      | PRD-locked first testnet (F0.8)                               |
| Public testnet #2 | Base Sepolia            | 84532         | Same L2 stack as mainnet; second-chain dry run (F1.4)         |
| Mainnet           | Base                    | 8453          | Audited v1 only                                               |

Base Sepolia comes **before** mainnet, not as an optional extra. It's the only testnet that
runs the same OP-stack gas and precompile behaviour as the target chain, and the F1.4 claim
("additional chains are a deployment decision, not a rewrite") is only shown once the scripts
have run unchanged on a second chain.

## 3. Code prerequisites (before any public deploy)

These are gaps in the repo today that make a public deployment unsafe or unrepeatable. They're
tracked as follow-ups in PRD F0.8 / F1.1 / F1.4.

1. **Split the deploy script.** `DeployMockOrg.s.sol` deploys `MockUSDC`, seeds a manager, a
   worker, an x402 target and a funded treasury. That's right for a demo and wrong for a release.
   Add a production script (e.g. `DeployOrg.s.sol` plus `DeployProtocol.s.sol` for
   `MarketplacePayments`) that:
   - takes the **asset address from per-chain config** (canonical USDC on Base
     `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; Circle's testnet USDC or `MockUSDC` on
     testnets) and **refuses to deploy a mock on any chain listed as mainnet**. The guard is an
     allowlist of mock chain IDs, not a guess about whether the chain looks like a mainnet. This
     matches the stance `relayRootSafeDeployment` already takes.
   - takes every role address (`HUMAN_ROOT`, `PLATFORM_FEE_RECIPIENT`, `MarketplacePayments`
     governor) explicitly, with **no `msg.sender` fallback** off Anvil.
   - ends with **post-condition assertions** in the same script run, so a half-wired deploy
     reverts instead of being published (see §5).
2. **Close the deployer's leftover authority.** `WhitelistPolicy` and `SpendCapPolicy` keep
   `admin` (the deployer) as a **permanent co-admin** next to the governor. Before an audit, admin
   should be dropped (set to zero) when `setGovernor` binds, the same way `Treasury` and
   `EscalationRouter` stop honouring `deployer` once a governor is set. Otherwise whoever ran the
   deploy keeps the power to widen the whitelist and raise caps forever.
3. **Resolve the open F1.1 enforcement items** the audit would otherwise rediscover: passed
   proposals with no execution expiry; a re-added agent address reviving its old pending intents;
   governance tier chosen by the proposer for most payloads.
4. **Add the missing RPC/explorer entries.** `contracts/foundry.toml` only lists `base_sepolia`
   and `base`. Add `sepolia` (and an Etherscan v2 key) so `forge script --verify` works on the
   PRD's first testnet without hand-passed flags.
5. **Make builds reproducible.** `solc_version = 0.8.28`, `via_ir = true` and
   `optimizer_runs = 200` are pinned in `foundry.toml`. Also pin forge-std and OpenZeppelin by tag
   (CI already does `forge-std@v1.16.2`, `openzeppelin-contracts@v5.3.0`) and record the Foundry
   version in each deployment record. `via_ir` output can change across compiler patch versions,
   and verification fails silently if the settings drift.
6. **Decide the emergency story before the audit.** There's no `pause` and no root withdrawal.
   Today, containing an incident means the root deactivates nodes (`OrgRegistry.setActive`),
   revokes session keys (`SessionRegistry`), and zeroes grants. Recovering funds means the root
   streaming allowance to itself and spending it through the router. Either write that down and
   rehearse it on testnet (stage 2), or add an explicit root-only exit and have it audited. Don't
   decide this after mainnet.

## 4. Keys and roles

| Role                                      | Who holds it    | Testnet                                                | Mainnet                                                                                                                                                                                                                  |
| ----------------------------------------- | --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Deployer** (pays gas, sends create txs) | Ops             | Fresh key from `pnpm wallet:new`, funded from a faucet | Fresh key **per release**, funded with just enough ETH, kept on a hardware wallet (`forge script --ledger` / `--trezor`), emptied and retired afterwards. **Never** the Anvil key: the CLI already refuses it off Anvil. |
| **Org human root** (reference org)        | LaCrew team     | Testnet Safe or EOA                                    | **Safe**, 2-of-3 hardware signers, not the deployer                                                                                                                                                                      |
| **`MarketplacePayments` governor**        | LaCrew          | Testnet Safe                                           | **Safe**, 2-of-3 (or 3-of-5) hardware signers on separate devices and people. Later: behind a timelock so a fee change is visible before it applies.                                                                     |
| **`PLATFORM_FEE_RECIPIENT`**              | LaCrew treasury | Any                                                    | A Safe, never an EOA                                                                                                                                                                                                     |
| **User org roots**                        | The user        | n/a                                                    | Their own root (passkey Safe by default, F1.3). Never touched by LaCrew.                                                                                                                                                 |

Rules:

- **The deployer ends with no authority.** Every bootstrap power the deployer has (Treasury and
  Router setters before `setGovernor`, `RateLimitPolicy.setRecorder`, the policy `admin`) is
  either handed to the GovernanceModule inside the same script or revoked. Stage exit includes a
  read-back proving it (§5).
- **Mainnet signing happens in a UI on a hardware device.** Safe transactions go through the Safe
  web app with each signer checking the calldata on their own device. Deploys go through
  `forge script --ledger` from a clean checkout of the release tag. No private key goes in a
  `.env` for mainnet.
- **Secrets stay out of the public repo.** RPC URLs and explorer keys live in the operator's
  environment or GitHub Actions secrets. The deployment JSON (public) holds addresses only.

## 5. Every deploy, every network: the release procedure

1. **Tag the commit.** `contracts-vX.Y.Z` on `main`, with CI green (tests, invariants, gas
   snapshot, Slither `--fail-high`, conformance). Mainnet tags must equal the audited commit, or
   the audited commit plus fixes the auditor reviewed.
2. **Build from a clean checkout of the tag.** Record `forge --version`, the solc version, and the
   runtime bytecode hash of each contract.
3. **Dry run against a fork** of the target chain: `forge script … --fork-url $RPC` with **no**
   `--broadcast`. Check the planned transactions, total gas, and that every address in the plan
   is the one intended (asset, roots, fee recipient).
4. **Broadcast** with `--slow` (one tx at a time; see the comment in `apps/cli/src/index.ts`) and
   `--verify`. Keep the `broadcast/` run file as the deployment receipt.
5. **Post-deploy assertions** (in the script, and repeated by an independent read-only check):
   - every contract's `governor` is the GovernanceModule, and policy `admin` is zero or the
     governor
   - `Treasury.token()` is the chain's canonical USDC (mainnet), never a mock
   - `EscalationRouter.treasury`, `rateRecorder` and `sessionRegistry` point at the stack just
     deployed, and `RateLimitPolicy.recorder` is the router
   - the deployer appears in no role
   - on-chain runtime bytecode equals the tagged build's artifacts (`cast code` vs `out/`,
     ignoring immutables and the metadata hash)
6. **Publish.** Commit `deployments/<chainId>.json` with the commit hash, tag, block number and
   tx hashes. Run `sync-abis` so `@lacrew/core` resolves the real addresses instead of the
   placeholders in `11155111.json` / `84532.json`. Update `lacrew.xyz/protocol` (F2.14) with the
   addresses, explorer links and audit status.
7. **Smoke-test the full flow** on the new chain: org creation → allowance streaming → ALLOW spend
   → ESCALATE → approval → proposal → vote → execution, plus session-key issue and revoke. This is
   the F0.8 exit criterion. Automate it as a CI job that runs against a chain ID on demand, so the
   same job proves testnet and mainnet.

Steps 3–7 should end up as a **manually-dispatched GitHub Actions workflow**
(`workflow_dispatch` with `chain` + `tag` inputs) for testnets. Then nobody has to remember the
flags, and the run log is the audit trail. Mainnet keeps a human holding a hardware key in the
loop, but runs the same script with the same assertions.

## 6. Stages, entry and exit

### Stage 0: Fork rehearsal (no public chain)

- **Do:** run the production script (§3.1) against an Anvil fork of Base mainnet using real USDC
  and the real Safe factories. Rehearse the whole release procedure (§5), including the
  incident playbook (§3.6) and a v1→v1.1 migration (deploy a new stack, move the treasury).
- **Exit:** every §5 assertion passes. The migration moves 100% of a funded treasury.

### Stage 1: Ethereum Sepolia (F0.8)

- **Enter:** §3.1, §3.2 and §3.4 merged.
- **Do:** deploy the reference org and `MarketplacePayments`, verify sources, publish addresses,
  point the docs and the cloud sandbox at them. Run the smoke flow and leave the orchestrator and
  examples running on it.
- **Exit:** smoke flow green. About **2 weeks of soak** with real usage (design partners, example
  crews) and no contract-level finding. Indexer and Guardian alerts tested against real events.

### Stage 2: Base Sepolia (F1.4 second-chain dry run)

- **Do:** the same tag, the same script, no code change, only config. Rehearse the incident
  playbook live: deactivate a node, revoke a session, recover funds through the root.
- **Exit:** smoke flow green on the second chain with zero diffs to contract or script code.

### Stage 3: Freeze and audit (F1.2)

- **Enter:** contracts feature-complete for v1 (the F0.2–F0.7 gaps closed), §3.3 and §3.6
  decided, stage 1 soak clean.
- **Do:** freeze a commit and send it, along with SPEC.md, SECURITY.md, the invariant suites and
  this plan, to the audit firm. Every fix lands as its own PR and gets reviewed by the auditor as
  a diff. Testnets redeploy from the post-fix tag and repeat the stage 1 smoke test.
- **Exit:** final report with every High and Medium fixed or explicitly accepted, published in the
  repo and on `lacrew.xyz/protocol`. Open a bug bounty (e.g. Immunefi) scoped to the audited tag
  **before** mainnet, not after.

### Stage 4: Base mainnet, guarded launch (F1.4)

- **Enter:** the go/no-go checklist (§7) is all yes.
- **Do:** run the §5 procedure with the hardware-wallet deployer from the audited tag. Then
  hand `MarketplacePayments` governance to the Safe and confirm the handoff with a Safe
  transaction.
- **Guardrails for the first weeks:** the cloud only offers mainnet to design partners. The
  SDK/CLI show a per-org treasury guidance cap (e.g. "beta: keep under $X"). Default spend caps
  in templates stay low. Guardian alerts route to the team. This is a product limit, not a
  contract limit, because the contracts must not grow an admin switch for it.
- **Exit:** about 4 weeks without incident. Then lift the guidance cap and open mainnet to all
  tenants.

### Stage 5: Steady state and new chains

- Each new EVM chain repeats stages 1→2→4 for that chain (its testnet, then mainnet) with the
  **same audited tag**. A contract change means a new tag, an audit of the diff, and a new
  version. Orgs on older versions keep working (nothing is upgradeable) and migrate when they
  choose.
- Monitoring: Guardian/indexer alert on governor changes, fee changes on `MarketplacePayments`,
  and unexpected large treasury outflows on the reference orgs.

## 7. Mainnet go/no-go checklist

- [ ] Audit report published; every High/Medium resolved or accepted in writing
- [ ] Deployed tag equals the audited commit (+ auditor-reviewed fixes only)
- [ ] Bug bounty live
- [ ] Production script refuses mocks on chain 8453; asset is canonical USDC
- [ ] Policy `admin` drops to zero on governor bind; the deployer holds no role after deploy
- [ ] Ethereum Sepolia and Base Sepolia both deployed from the same tag, smoke flow green, soak clean
- [ ] Fork rehearsal of a version migration moved the full treasury
- [ ] Incident playbook written and rehearsed on testnet
- [ ] Deployer is a hardware wallet. Protocol roles are Safes with ≥2 hardware signers.
- [ ] Post-deploy assertion script and bytecode-match check ready to run
- [ ] `lacrew.xyz/protocol` ready to show addresses, verification links and the audit
