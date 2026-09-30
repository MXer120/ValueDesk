# Valuescan: Roadmap

An on-chain address tracking and analytics platform on **ValueChain / SoDEX**, with opt-in copy trading.

## The two big steps

### Step 1: Track & analyze
Index and analyze on-chain trader addresses on **SoDEX** and **Hyperliquid** (more venues later), to find the ones with high win rates and high PnL.
Pages: **Explore**, **Leaderboard**, **Scan** (address detail), **Trade**, **Portfolio**, and the Cmd+K search.

### Step 2: Copy trading (opt-in)
A user picks an address and switches on copy trading themselves. The actual trades are **executed on SoDEX**, in the user's own SoDEX account, through **SoDEX's SDK**, with **Valuescan's builder code** attached. The builder code is how Valuescan earns.

- **We never move funds.** SoDEX handles all funds, margin and settlement.
- The only on-chain piece is the **copy trading contract**: a decentralised, public record of who copies whom, under which rules, through which executor, and at which maximum builder fee. It holds no funds.

> **Hard rule:** nothing is deployed on-chain (mainnet or testnet) without an explicit go from the owner.
> Contracts are written, tested and audited locally only.

## Where things are

| Area | Location |
|---|---|
| Frontend (Valuetrade base + new pages) | `apps/web` |
| Backend (Valuetrade server + `/api/vs/*` SoDEX/Hyperliquid trader data) | `apps/server` |
| SoDEX signing library (browser-safe) | `packages/sodex-core` |
| Copy trading contract (Foundry) | `contracts/` |
| Contract spec & integration | `docs/contracts/` |
| Research | `docs/research/` (07 and 08 correct 01 and 03) |
