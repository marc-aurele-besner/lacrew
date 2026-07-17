---
name: verify
description: Build, launch, and drive mymultisig-app headlessly (with a real wallet + chain) to verify UI/web3 changes at the browser surface.
---

# Verifying mymultisig-app changes

## Build & serve

```bash
yarn build             # production build (also the lint gate)
npx next start -p 4123 # serve it; do NOT use `yarn start` (runs a deploy script)
```

## Drive headlessly

Playwright browsers are cached in `~/Library/Caches/ms-playwright` (use the newest
`chromium-*` dir as `executablePath` with `playwright-core`; install `playwright-core`
in the scratchpad, not the repo).

Gotchas, in the order you hit them:

1. **Disclaimer modal** blocks everything on first load — click "I understand and accept".
2. **`/multisig/[address]` pages return `null` unless a wallet is connected**
   (`useAccount().address` gate in `src/pages/multisig/[multisigAddress].tsx`).
3. Default chain is mainnet (first entry of `src/constants/networks.ts`); the header
   network selector works while disconnected (wagmi `useSwitchChain`).

## Real wallet + chain without funds (anvil fork)

For flows that need a connected wallet or real transactions:

```bash
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --silent   # keeps chainId 11155111
```

- Wagmi transports use each chain's default RPC; for Sepolia that is
  `https://11155111.rpc.thirdweb.com` (check `sepolia.rpcUrls` in the installed viem).
  Use Playwright `context.route()` to proxy that URL to `http://127.0.0.1:8545`.
- Inject a minimal EIP-1193 `window.ethereum` via `context.addInitScript` that answers
  `eth_requestAccounts`/`eth_accounts` with anvil account #0
  (`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`), `eth_chainId` with `0xaa36a7`, and
  forwards everything else to the routed RPC URL. Keep `isMetaMask: false`, then connect
  via header "Connect" → "Injected".
- `eth_sendTransaction` works as-is (anvil accounts are unlocked), so writes confirm
  for real and `useWaitForTransactionReceipt` resolves.
- A live test multisig exists on Sepolia: `0x22FFbC1D573e1914b0C779044f91dec2B0547c29`
  ("My test multisig", 2-of-3). Factory: `0x5c529198e6b4d2DCBb2f3201062A7e9194298d5a`.
- To seed ERC-20 balances: `anvil_setStorageAt` on the token, balances mapping —
  Sepolia LINK (`0x779877A7B0D9E8603169DdbD7836e478b4624789`) uses slot 0
  (`keccak256(pad(account) ++ pad(0))`).

## Flows worth driving

- Overview tab: `/multisig/<address>` — stat tiles, Fund wallet modal.
- Component-only changes can also be eyeballed via `yarn storybook` (port 6006),
  but prefer the real page when the change touches wagmi hooks.
