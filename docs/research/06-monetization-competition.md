# 06 — Monetization and competitive landscape

Research for **ValueDesk** (cross-venue trader analytics + non-custodial copy trading on SoDEX / ValueChain, then Hyperliquid).
Date: 2026-09-25. Research was read-only: public docs, public GET/POST info queries, `eth_call`. No signed requests, no accounts, no deployments, no cloud resources.

Confidence labels: **verified** = observed live or in code today; **documented** = official docs; **reported** = third-party article/dashboard; **inferred** = my reasoning from the above; **assumption** = not checked.

---

## TL;DR

1. **Builder codes are the business model, and SoDEX's builder ecosystem is nearly empty.** SoDEX lets a builder charge up to **0.2% on perps** and **2% on spot** (sell side only), credited **in real time** to the builder's account with no claim step. I checked the public `GET /api/v1/user/{addr}/builders` endpoint for the **top 500 SoDEX traders by 30D volume**: only **4 (0.8%)** have approved any builder, and all 4 approved the same unidentified builder (account `223169`) at the **0.2% perps cap**. That builder holds about 433 vUSDC. **No serious SoDEX builder or copy-trading product exists yet.** ValueDesk can be the first.
2. **SoDEX is small next to Hyperliquid.** SoDEX perps averaged **about $140M/day** over the last 30 days (spiky: $44M to $601M). Spot was about $1.5M/day. Hyperliquid's main dex did **$7.16B** in 24h. SoDEX gives us a first-mover position. Hyperliquid is where the volume is.
3. **What Hyperliquid builders earn (the ceiling).** Phantom has earned **$26.3M** in builder rewards to date (verified live with the HL info API). It charges 5 bps and currently earns about $1.2M per 30 days. Across **116 HL interfaces**, builder fees total about **$8.5M per 30 days**. Copy-trading builders earn far less: Hyperdash about $208k/30d, pvp.trade about $14k/30d (down from $8M lifetime), HyperX about $10k/30d, Katoshi about $0. Most HL builder revenue goes to wallets and distribution (Phantom, MetaMask, Trust, Based). **Distribution matters more than features.**
4. **Market rate for copy trading is 5 bps.** Hyperdash charges 0.05% on all copy fills. Copin charges 0.05% on opening fills only. Nansen charges 1–8 bps by loyalty tier. Phantom charges 5 bps, Based 2.5 bps, Axiom and Insilico 1 bp, MetaMask 10 bps.
5. **Recommended launch pricing: 5 bps on opening and increasing copy fills only, 0 on closes.** On SoDEX a copied round trip then costs about **13 bps** in total. The HL incumbents cost 14–19 bps. We also **ask users to approve at most 0.05%, not the 0.2% cap**, and say so on screen.
6. **Pay leaders from builder fees. Do not use performance fees.** A true profit share needs to move followers' funds, and every SoDEX fund movement needs a key with transfer permission. That breaks the Opentrade guarantee that "the key cannot move funds" and raises custody and licensing questions.
   - **Launch model:** leaders get **30% of the builder fees their followers generate**. Payment is **profit-gated** (only if the leader's followers are net positive over 30 days) and goes only to leaders who **claim their address** by signing a message.
   - **Later:** an optional on-chain *fee-escrow* contract for leaders who want performance fees.
7. **Stack the free revenue lines on top.**
   - **SoDEX referral:** 10% of referees' trading fees plus 25% of their SoPoints, with Squad boosts in the Layer 1 Season (started 2026-09-01, 20 weeks, 900k SoPoints/week). The Early-Bird Squad window **closes 2026-09-29 12:00 UTC**.
   - **HL referral:** 10% of referees' fees for their first $1B of volume. Phantom stacks it: about $2.3M on top of its builder fees.
   - **SoPoints for followers:** copied volume earns SoPoints on the follower's own account, which is a strong selling point during the season.
8. **Analytics must stay free at launch.** Every direct analytics competitor is free: HL leaderboard, Hyperdash, ASXN, HypurrScan, the SoDEX leaderboard, CommunityScan Sodex, SodexTracker.
   - **Charge later for:** alerts and Pro tooling (about $19/mo) and a cross-venue data API ($99–$999/mo). HyperTracker charges $179–$2,399/mo, CoinGlass $29–$699/mo, Hydromancer $300–$2,500/mo.

---

## 1. Builder-code economics

### 1.1 SoDEX builder codes (documented + partly verified)

Source: <https://sodex.com/documentation/for-developers/developers/trading/builder-codes-in-trading>

| Parameter | Value |
|---|---|
| Units | `fee` / `maxFeeRate` are integers in **tenths of a basis point** (10 = 1 bp) |
| Perps cap | **200** = 20 bp = 0.2% |
| Spot cap | **2000** = 200 bp = 2% |
| Which side pays | "Builder codes currently only apply to fees collected in the **quote or collateral asset**. They do not apply to the buying side of spot trades; they apply to both sides of perp trades." |
| Builder eligibility | Activated account with **≥100 vUSDC in Spot AND ≥100 vUSDC in Perps**. Builder ID = numeric account ID (`data.aid` / `primaryAccountID`). No separate registration. |
| User approval | Must be signed by the **master wallet** (not an API key). `ApproveBuilderFeeAction {chainID, nonce, accountID, builderID, maxFeeRate}`, or combined `AddAPIKeyWithBuilder {chainID, nonce, accountID, name, keyType, publicKey, expiresAt, builderID, maxFeeRate}`. EIP-712 domain `universal`/`1`, message-level `chainID` 286623 (mainnet) / 138565 (testnet). |
| Approval limits | **Max 10 active builder approvals per user**. Revoke by approving `maxFeeRate: 0`. Approval succeeds only if both engines accept. |
| Order field | `"builder": {"id": <builderAccountId>, "fee": <tenths-of-bp>}`, always the **last field** of its struct. Spot: at batch level. Perps: batch default plus per-order override. Orders naming an unapproved builder are **rejected**. |
| Settlement | Credited **in real time** to the builder account on the engine that produced the fill. **No claim step.** |
| Reconciliation | Per-fill REST field `builderFee`, WS field `bf`. `accountUpdate` has no per-credit ID, so reconcile from fills, not balance deltas. |
| Query approvals | `GET /api/v1/user/{userAddress}/builders` → `data.spot[]`, `data.perps[]` with `{userID, builderID, feeRate}`. **Public, no auth** (verified). |
| Payout path | Perps → Spot → ValueChain EVM → external (standard withdrawal). |
| Caveat | "`builder` and `permissions` are **mutually exclusive** within a registration request." The docs do not say what permission mask a key made with `AddAPIKeyWithBuilder` gets. |

**Verified live (2026-09-25):**

- **Public approvals endpoint works.** `GET https://mainnet-gw.sodex.dev/api/v1/user/0xff39…9403/builders` returns `{"code":0,…,"data":{"spot":[],"perps":[]}}`.
- **Adoption scan of the top 500 SoDEX wallets** (30D volume, from `mainnet-data.sodex.dev/api/v1/leaderboard?window_type=30D&sort_by=volume&page=1..10&page_size=50`):
  - **4/500** have any approval: ranks 65 and 80 among them.
  - These 4 wallets have only **$3M of the $829M** 30D volume in the sample.
  - **All 4** approved builder **223169** at `feeRate` **500 spot (0.5%)** and **200 perps (0.2%, the cap)**.
- **Builder 223169 resolved on-chain** with `eth_call` to exchange `0x0101…0101`, selector `0x792713b8` (owner-of-account, as used in Opentrade `server/src/sodex/chain.ts:498`): EOA `0x6dc379a459bf15b541d603305e95b25a7db98f0d`. It has no Blockscout tags.
  - Balances: perps **100 vUSDC** (exactly the minimum), spot **432.88 vUSDC**.
  - So its lifetime builder income is at most a few hundred dollars.
- **Conclusion:** SoDEX builder codes are live and working but essentially unused. No incumbent owns SoDEX order flow.

**Two design implications for our onboarding (flagged for the architecture report):**
- **Two signatures, not one.** SoDEX allows at most **5 API keys per master account** (`api-keys-and-nonces` doc), and `builder` and `permissions` cannot be combined. The safe onboarding is therefore two master-wallet signatures:
  1. `addPermissionedAPIKey` with mask `TRADE|CANCEL = 3` (Opentrade `server/src/signing/actions.ts:53-55`);
  2. `approveBuilderFee`.
- **Do not use `AddAPIKeyWithBuilder` for the copy key** until someone verifies on testnet what mask it grants. That check needs an owner go, because it is a signed action.

### 1.2 Hyperliquid builder codes (documented + verified)

Source: <https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes>

| Parameter | Value |
|---|---|
| Caps | **0.1% perps, 1% spot** (confirmed; the spot figure in the brief was right) |
| Units | `f` in tenths of a basis point; order field `{"b": builderAddress, "f": number}` |
| Approval | `ApproveBuilderFee`, signed by **main wallet, not agent**. Max **10** active approvals per user. |
| Builder eligibility | ≥**100 USDC perps account value**, "standard" account-abstraction mode |
| Spot | Sell side only (same rule as SoDEX) |
| Revenue claim | Through the referral-reward claim flow. The total is in `{"type":"referral","user":…}` → `builderRewards`. |
| Approved cap per user | `{"type":"maxBuilderFee","user":…,"builder":…}` |
| Per-builder fill data | `https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/{builder_lowercase}/{YYYYMMDD}.csv.lz4`. **Public HTTP, not requester-pays.** Verified with a HEAD request: Phantom's 2026-09-24 file is 1,165,814 bytes, `Last-Modified 2026-09-25 01:58 UTC`. |

The `builder_fills` feed matters strategically: **any HL builder's daily routed volume and users can be measured exactly, for free.** That includes Hyperdash, Copin and every copy competitor. It is a ready competitive-intelligence source and a candidate "builder leaderboard" feature for ValueDesk.

### 1.3 Base exchange fees (what followers already pay)

| Venue | Perps taker / maker (tier 0) | Spot taker / maker | Tier window | Source |
|---|---|---|---|---|
| SoDEX | **0.040% / 0.012%** | 0.065% / 0.035% | Rolling 14D, weighted = perps + 2×spot. 7 tiers, down to 0.022% taker at >$7B. SOSO staking discount 5–40%. Maker rebates 1–3 bp. | Verified against `/fee-rate` (Opentrade `web/src/fees.ts:31-84`) and the docs |
| Hyperliquid | **0.045% / 0.015%** | 0.070% / 0.040% | Rolling 14D. HYPE staking discount 5–40%. | <https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees> |

Copy orders are mostly **taker** (market or aggressive limit, to minimise lag). The builder fee is charged **on top** of these fees.

### 1.4 Revenue model

Revenue = routed notional × builder fee. For perps, "routed notional" counts **each fill**, so an open and a close count twice. For spot, only sells pay.

**Gross monthly revenue (30 days), perps:**

| Daily routed volume | 1 bp | 2.5 bp | 5 bp | 10 bp |
|---|---|---|---|---|
| **$1M/day** | $3,000 | $7,500 | $15,000 | $30,000 |
| **$10M/day** | $30,000 | $75,000 | $150,000 | $300,000 |
| **$100M/day** | $300,000 | $750,000 | $1,500,000 | $3,000,000 |

**What these volumes mean in market share (verified volumes):**

| Daily routed volume | Share of SoDEX perps (30D avg ≈ $140M/day) | Share of HL perps (24h $7.16B) |
|---|---|---|
| $1M | 0.7% | 0.014% |
| $10M | 7% | 0.14% |
| $100M | ~70% (not realistic on SoDEX alone) | 1.4% |

**Adjustments:**
- **Opens-only charging** (recommended below) roughly halves the effective rate. 5 bp on opens is about 2.5 bp on all fills.
- **Leader share:** 30% of builder fees from followed-leader flow. Net to ValueDesk is 70%.
- **SoDEX spot:** about $1.5M/day for the whole venue, and builder fees only hit sells. Ignore it for revenue planning.
- **Referral stacking adds about 0.4–0.45 bp of volume** (10% of a 4–4.5 bp taker fee) on users who registered through our code. SoDEX: 10% fee rebate. HL: 10% of fees for the referee's first $1B.

**Benchmarks: what real HL builders earn** (DefiLlama `api.llama.fi` fee summaries, pulled 2026-09-25):

| Builder | Type | Fee charged | 30D fees | Lifetime |
|---|---|---|---|---|
| Phantom Perps | Wallet | 5 bp | $1,211,192 | $25.8M (HL info API `builderRewards` today: **$26,309,468**, verified) |
| MetaMask Perps | Wallet | 10 bp | $1,612,686 | $11.0M |
| Trust Wallet Perps | Wallet | n/a | $1,409,068 | $2.3M |
| HyperDash | Analytics + terminal + **copy** | 5 bp copy, 1.5 bp terminal (reported) | **$208,103** | $787k |
| Insilico Terminal | Pro terminal | 1 bp | $169,098 | $4.10M (HL API **$4,053,266**, verified) |
| BasedApp | App | 2.5 bp | $49,975 | $15.3M |
| Axiom Perps | Memecoin terminal | 1 bp | $34,282 | $1.73M |
| pvp.trade | TG bot + **copy** | ~3.8 bp (reported) | **$14,138** | $8.0M |
| HyperX Perps | **Copy** | n/a | $10,225 | $167k |
| Dexari | Mobile | n/a | $9,701 | $638k |
| Nansen Perps | Analytics + trade | 1–8 bp by tier | $3,462 | $124k |
| Katoshi Perps | Bots/AI + copy | 1–2 bp (reported) | $121 | $14.5k |
| **All 116 HL "Interface" builders, excluding tradeXYZ (a HIP-3 deployer)** | | | **≈ $8.52M** | ≈ $105M |
| *Hyperliquid Perps protocol fees (reference)* | | | *$71.9M* | |
| *SoDEX Perps protocol fees (reference)* | | | *$284,906* | *$1.66M* |

**Reading the benchmarks (inferred):**
- **Builder revenue follows distribution, not features.** Wallets with millions of users capture most of it.
- **Copy-trading builders are small.** Hyperdash, the best-known HL analytics site, earns about $7k/day across everything. Implied routed volume is about $14–46M/day, depending on the 1.5 bp / 5 bp mix.
- **Realistic ValueDesk year-1 range:** $5–50k/month gross, unless a distribution partner (a wallet, or SoSoValue itself) routes users to us.
- **SoDEX signal to check:** SoDEX's own perps fee income (~$285k/30d) against ~$4.35B volume implies an average of only ~0.65 bp per unit of reported volume. Likely causes: a large share of volume from zero-fee tier-4+ makers or MM/incentive flow, or the dashboard double-counting. Either way, **headline SoDEX volume overstates the organic, fee-paying taker flow a copy product can capture.** Plan on the organic subset.

**Published Hyperliquid builder snapshots (reported, CoinGecko / HyperTracker, 2026-05-25):**

| Builder | Revenue | Volume | Users | Fee |
|---|---|---|---|---|
| Phantom | $20.63M | $39.4B | 137,496 | 0.05% |
| Based | $15.06M | $44.0B | 42,579 | 0.025% |
| PVP | $7.95M | $16.9B | 28,189 | 0.038% |
| MetaMask | $6.51M | $7.46B | 43,761 | 0.1% |
| Insilico | $3.31M | $32.2B | 2,962 | 0.01% |
| Infinex | $2.71M | $5.04B | — | 0.05% |
| Axiom | $2.27M | $22.1B | 33,361 | 0.01% |
| Tread.fi | $2.05M | $9.98B | — | 0.02% |
| Mass | $1.38M | $2.39B | — | 0.055% |

Also reported: "$40M+ total builder revenue, 187 active builders, ~⅓ of HL flow via third-party builders" (Dwellir, 2026-01-16). Hyperliquid itself said "100+ teams" had integrated builder codes.

---

## 2. Copy-trading business models

### 2.1 Leader profit share: norms

| Venue | Leader share | Notes | Source |
|---|---|---|---|
| Binance Futures | up to **30%** of copier profit + **10%** of copiers' trading fees | Lead-trader programme | Binance FAQ (reported via search) |
| Bybit | **10–15%** by master-trader rank | Settled on close/weekly | Bybit help centre |
| OKX | **8–13%** by level (spot max 13%) | | OKX help centre |
| Bitget | Futures up to **20%** (new 0–13%), bots up to 30% | | Bitget support |
| Hyperliquid vaults (legacy) | **10%** profit share. Leader must hold **≥5%**. Min 100 USDC. **Creation fee 10k USDC** (current docs). Perps only, no HIP-3 or spot. | HL now points builders at **HyperEVM vaults using CoreWriter**, which allow custom accounting such as EIP-4626 share price and performance fees. | <https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/for-vault-leaders-legacy>, `/hypercore/vaults` |
| Hyperdash, Copin, HyperX (HL copy) | **0%** to leaders | Leaders are copied without consent and paid nothing. Platform takes 5 bp. | docs.hyperdash.com/copy-trade, Copin fee docs (via search) |

**Gap:** no on-chain copy product pays the traders being copied. That is a recruiting weapon. "Claim your address, you've earned $X from followers" is a strong growth loop.

### 2.2 Platform fees and subscriptions

| Product | Model | Price points |
|---|---|---|
| Hyperdash | Free analytics. Builder fee on trades. | Copy 0.05% on all fills. Copy volume "not eligible for fee rebates". Terminal ~1.5 bp (reported). |
| Copin | Freemium subscription (Free / Starter / Pro / Elite, 10% off annual; earlier Premium NFT 0.01→0.03 ETH) plus DCP fee | **0.05% on opening size** (HL). gTrade DCP 0.05% total. **USD plan prices are not public without login** (docs.copin.io returns 403/1014 to scripted fetches). |
| Nansen | Subscription + trading | **Pro $49/mo annual, $69 monthly**. HL perps builder fee **8 / 5 / 3 / 2 / 1 bp** by points tier (Unranked / Green-Pro / Ice / North / Star). Launched June 2026. |
| HyperTracker (CoinMarketMan) | Data API | Free 100 req/day. **Pulse $179, Surge $499, Flow $1,159, Stream $2,399/mo.** |
| CoinGlass | Data API | **$29 / $79 / $299 / $699/mo**, then enterprise |
| Hydromancer | Low-latency data | **$300 / $1,200 / $2,500/mo** |
| ASXN HyperScreener, HypurrScan, HL leaderboard | Free | — |
| Katoshi | Subscription tiers that lower the builder fee | Lowest tier 0.02% perps / 0.2% spot. Or **1 USDC/day/bot** in vault mode. |
| Hyperbot | Membership + `$BOT` token | Tiers not published on the landing page. HL and Aster. |
| HyperCopy (hypercopy.xyz / .online) | Open-source, free | "No fees" |

**Price anchor for a ValueDesk Pro tier: $15–25/mo.** Above free, well below Nansen Pro. The data API should sit at **$99–999/mo**, under HyperTracker, and sell the one thing nobody else has: **SoDEX + HL cross-venue data**.

### 2.3 Referral programmes (stack on top of builder fees)

| Venue | Referrer earns | Referee gets | Unlock | Notes |
|---|---|---|---|---|
| **SoDEX** (mainnet, since 2026-01-01) | **10% fee rebate** on referees' trading fees + **25% of their SoPoints** | +5% SoPoints boost | $1,000 own volume | Binding happens at sign-up. Opentrade found registration **can only happen on sodex.com**, so we must send new users there anyway (README "Why the ValueChain route needs an account first"). **That step is where our referral link goes.** |
| SoDEX Layer 1 Season (2026-09-01, 20 weeks) | Squad Energy: $1 of squad volume = 1 Energy. Boost +5% (100k) up to **+25% (10M)**. **Early-Bird +20%** for squads formed or joined **before 2026-09-29 12:00 UTC**. Total stackable up to +70%. | Pool 900k SoPoints/week. Treasure boxes up to 10k USDC. Organic bonus 2M SoPoints/week for Aug-2026 actives. | | <https://sodex.com/documentation/sopoints/layer-1-season.md> |
| SoDEX Wealth | `bytes32 referral` on vault `requestDeposit/requestRedeem` | | | <https://sodex.com/documentation/for-developers/developers/wealth/referrals.md>. Payout terms not documented. |
| **Hyperliquid** | **10% of referees' fees** (minus their discount), for referee's first **$1B** volume | **4% fee discount** for first $25M | $10k own volume | Link `app.hyperliquid.xyz/join/CODE`. Not for vaults or sub-accounts. **Verified stacking:** Phantom's referral state shows code `PURPS`, **183,423 referrals**, and claimed + unclaimed rewards of $28.64M against `builderRewards` of $26.31M. So about **$2.3M (≈9%)** came from referrals on top of builder fees. |

### 2.4 Ecosystem grants, incentives, points

- **SoSoValue / ValueChain:** **150M SOSO** allocated for ecosystem incentives. At $0.3143 today that is about $47M (SOSO market cap $107.5M, CoinGecko). Reported coverage calls it a "$70M reward pool".
  - **No public builder-grant or builder-incentive programme found** in the SoDEX docs index (`sodex.com/documentation/llms.txt`), the support centre or news.
  - The builder-codes doc describes **no revenue share or builder incentive**.
  - **Unknowable read-only.** Verify through SoSoValue BD.
- **SoPoints:**
  - Season 1: 2026-02-01 → 2026-08-01, 1M SoPoints/week; SOSO claim opened 2026-02-13; S1 distribution 2026-05-08.
  - Layer 1 Season: 2026-09-01, 20 weeks (to about 2027-01-19), 900k/week, earned from spot and futures **volume and OI**, Wealth holdings and invites.
  - **Copy trades earn SoPoints for the follower's own account** (inferred: points attach to the account that trades). That is a concrete reason to copy on SoDEX rather than HL during the season.
  - The points pages do not mention builder-attributed volume. A **"builder boost" for SoDEX-native frontends is a partnership ask**, not an existing feature.
- **Opentrade finding:** SoPoints data for any wallet is readable with a wallet-signed SoDEX JWT (`sodex.com/auth/v2/nonce|verify` → `alpha-biz.sodex.dev/biz/sopoints/summary`), see NOTES.md:353-393. For a hosted app those calls **must move to the browser**, which needs SoDEX to add our origin to its CORS allowlist (DEPLOYMENT.md:175-193). Add it to the BD asks.
- **Our own points/token:** not at launch (see §4).

### 2.5 Sharing revenue with leaders non-custodially

**The core constraint (verified in Opentrade):** SoDEX has **no user-signed transfer or withdraw action**. Every fund movement is signed by an API key whose mask includes `TRANSFER (8)` or `WITHDRAW (4)` (`server/src/signing/actions.ts:53`). Opentrade's security model rests on the resting key being `TRADE|CANCEL (3)`, with money movement elevated just-in-time, once per operation, with a wallet prompt (README "Moving money"). On HL, `usdSend`/`withdraw` are main-wallet signed actions.

| Option | How it works | Custody / trust | Verdict |
|---|---|---|---|
| **A. Builder-fee share to leaders** | Builder fees land in **our** builder account. Weekly, we attribute each fill's `builderFee`/`bf` to the leader it copied and pay the leader X%. | Touches **only our own revenue**. Followers' funds are never touched. | **Launch with this.** |
| A+. With an on-chain Merkle distributor | Publish weekly `(leader, amount)` Merkle root. Leaders claim vUSDC on ValueChain EVM. Fill-level CSV published for audit. | Same as A, but auditable. **Needs a contract deployment: owner go required.** | Phase 2 |
| **B. Opens-only fee with a leader-set surcharge** | Leader picks a "follow fee" of 0–5 bp added to our 5 bp (still ≤ 10 bp HL / ≤ 20 bp SoDEX cap). We pass 100% of the surcharge through. | Same as A | Phase 2, for premium leaders |
| **C. Performance fee, follower-signed settlement** | Each period we compute HWM PnL and the follower signs a transfer to the leader. | Non-custodial but **unenforceable**: follower can refuse. Enforcement = stop copying. Wallet prompt every period. | Optional, low value |
| **D. Performance fee via prepaid fee escrow** | Follower deposits a fee budget (e.g. 25 vUSDC) into an escrow contract on ValueChain. Keeper posts signed epoch PnL. Contract pays leader + platform, capped at `min(budget, p% × attested profit)`. Challenge window. Follower can withdraw the unspent budget at any time. | Trading capital stays in the follower's account. Escrow holds only the fee budget. Trust is in the PnL attestation, mitigated by a public fill log and the challenge window. **Needs contract deployment + audit.** | Phase 3 |
| **E. Transfer-permission key held by our server** | Server can pull fees whenever it wants | Our key could **move all follower funds** anywhere. Custody in substance. Licensing trigger (DEPLOYMENT.md:170). | **Reject** |
| **F. Pooled vault (HL HyperEVM + CoreWriter)** | EIP-4626 vault trades on HyperCore. Share-price accounting with HWM performance fee. | Contract custody of pooled funds. On-chain and trustless, but pooled = fund-like. HL legacy vaults need 10k USDC plus a 5% leader stake. | Phase 3, HL only, legal review first |
| **G. SoDEX equivalent of F** | Would need an EVM→SoDEX trading precompile or user-created vaults. SoDEX Wealth vaults are **SoDEX-curated** (`escrow_vault` fund types). No user-created leader vaults are documented. | Unknown | **Open question** for the contract report |

**Incentive fix for option A (inferred):** paying leaders on follower *volume* rewards churn. Two safeguards:
- **Profit-gate:** pay a leader only if their followers' copied PnL over trailing 30D is ≥ 0.
- **Turnover cap:** cap the paid share at N× the follower's equity per month.

This also blunts the known exploit where a leader opens in a thin market, followers buy in behind, and the leader sells into them. That risk is higher on SoDEX's thinner books, so also **restrict copying to markets above a depth threshold**.

**Leader consent:** only addresses that **claim** their profile (by signing a message) receive payouts. Unclaimed accruals are held for 90 days and shown publicly as "unclaimed: $X". Uncopied or opted-out addresses can be hidden from copying on request.

---

## 3. Competitive landscape

| # | Product | Venues | Analytics | Copy trading / execution model | Pricing | Weaknesses / gap |
|---|---|---|---|---|---|---|
| 1 | **Hyperdash** (pvp.trade team) | HL | Best-in-class HL dashboard, Alpha leaderboard, cohorts | Yes. Dedicated copy wallet, either created by Hyperdash or connected via **API key (180-day expiry)**. Up to 10 targets per wallet. 1–40× leverage cap. Slippage limit. White/blacklists. **Countertrade** mode. Perps only. | Free UI. **0.05% builder fee on copy fills.** ~1.5 bp terminal. | HL-only. No leader payouts. No public API. 30D fees ~$208k: it is the leader, but not huge. |
| 2 | **HypurrScan** | HL | Explorer: txs, TWAPs, auctions, whale flows | No | Free, no token. 7 free API endpoints. | Explorer, not analytics. No copy. |
| 3 | **Hyperliquid leaderboard + vaults** | HL | Native leaderboard (PnL/ROI/volume windows) | Vaults: 10% profit share, leader ≥5%, 10k USDC creation fee. Pooled. | Free | Pooled, no per-user control, perps only. Legacy vaults deprecated in favour of HyperEVM vaults. |
| 4 | **CoinGlass** (HL whale tracker) | HL + CEX data | Whale positions, liquidation maps, long/short | No | Web free. API $29–699/mo. | No execution. Generic. |
| 5 | **Nansen** | Multi-chain + HL | 500M+ labelled wallets, Smart Money perp trades API | **No copy**, but HL perps trading (June 2026) | Pro $49–69/mo. Builder fee 1–8 bp by tier. | Trading volume tiny ($3.5k/30d fees). No SoDEX. |
| 6 | **ASXN HyperScreener** | HL | Whales, liquidations, top traders, funding | No | Free | Daily refresh. No execution. |
| 7 | **Copin** | HL, GMX, gTrade, Kwenta, others + **CEX copy** (Binance etc.) | 700k+ traders, backtests, alerts | Yes. **HL via agent/API wallet.** Also DCP via gTrade. Cannot close positions inside Copin (reported). | Free/Starter/Pro/Elite (prices behind login). **0.05% on opening size.** | Multi-venue breadth but shallow integration. **No SoDEX.** No leader pay. |
| 8 | **Katoshi** | HL | Bots, AI agents, strategy marketplace | Automation plus copy via webhooks/agents | Tiered builder fee (~1–2 bp perps), or 1 USDC/day/bot in vault mode | Negligible routed volume ($121 fees/30d). |
| 9 | **HyperCopy** (hypercopy.xyz) | HL | Minimal | Open-source bot, WebSocket mirroring | Free | DIY, no analytics, no support |
| 10 | **Hyperbot** (hyperbot.network) | HL, **Aster** | Whale tracker (top-100 capital, 60s refresh), AI signals | One-click copy, grid bots | Membership + `$BOT` token (4% HL fee discount claimed) | Token-driven. Two venues. |
| 11 | **HyperX** | HL | AI ranking, PnL curves, drawdown, style classification | Copy with 10–200% ratio, whitelist/blacklist | Undisclosed. $10k builder fees/30d. | HL-only |
| 12 | **HyperTracker** (CoinMarketMan) | HL | 16 behavioural cohorts, liquidation-risk scoring, leaderboards | No (trading app UI) | Free, then API $179–2,399/mo | Data vendor, not execution |
| 13 | **Arkham** | Multi-chain + **HL since 2026-07-17** | Entity de-anonymisation, HL positions, PnL, trade history per entity | No | Core free. API by application. | No execution. Identity-heavy. |
| 14 | **pvp.trade** | HL (Telegram) | Social | TG bot copy trading | Builder fee (~3.8 bp reported) | Fading: $14k/30d fees against $8M lifetime |
| 15 | **SoDEX official leaderboard** (sodex.com/leaderboard) | SoDEX | PnL/volume, 24H/7D/30D/All, hourly refresh. Public API `mainnet-data.sodex.dev/api/v1/leaderboard[/rank]`. **134,605 wallets** in the 30D window (verified). | **No copy** | Free | Ranking only. No per-trader deep analytics. |
| 16 | **CommunityScan Sodex** (communityscan-sodex.com) | SoDEX | "#1 Data Intelligence Layer": wallet PnL, leaderboards. Public `/api/public/wallet/{addr}`, used by Opentrade's Scan page (`server/src/routes/scan.ts:27`). | No | Free | Analytics only. Third-party dependency for us. |
| 17 | **SodexTracker** (sodextracker.com, GitHub EliasD87) | SoDEX | Positions, leaderboard, watchlists, reverse search, paper trading, journal | No | Free (2 GitHub stars) | Hobby project |
| 18 | **CEX copy trading** (Binance, Bybit, OKX, Bitget) — reference | CEX | Rich lead-trader stats, verified by exchange | Native. Leader profit share 8–30%. Binance also pays leaders 10% of fees. | Profit share + trading fees | Custodial, KYC, opaque. Leaders **opt in and get paid**: the UX bar for "trader profiles". |

**The gap ValueDesk can own (inferred):**
1. **First SoDEX-native copy trading.** Zero competitors execute copies on SoDEX, and the builder-approval scan shows no incumbent flow.
2. **Cross-venue trader identity and copy.** Track and copy the same strategy across SoDEX and HL. Only Copin is multi-venue, and it lacks SoDEX.
3. **Leaders get paid, with on-chain proof.** No DEX copy product pays leaders. A claimable, auditable payout (Merkle root on ValueChain) is new.
4. **Honest fee posture.** Approve 0.05% max, not the cap. Opens-only fee. Never a fund-moving key (Opentrade's verified security model carried over).
5. **SoPoints-aware copying** during the Layer 1 Season.
6. **Best UX**, built on Opentrade's verified signing, deposits and onboarding.

---

## 4. Recommended phased monetization plan

### Phase 1 — Launch (SoDEX only, months 0–3)

**Goal:** become SoDEX's default copy and analytics front-end. Earn trust. Collect builder approvals.

| Line | Price | Reasoning |
|---|---|---|
| Copy trades (perps) | **5 bp (fee=50) on opening/increasing fills. 0 on reduce-only, TP/SL, emergency close.** | Matches the Copin/Hyperdash headline rate, but opens-only makes it about 2.5 bp effective. Follower round trip on SoDEX tier 0: 4 + 4 + 5 = **13 bp**, against 14 bp (Copin on HL) and 19 bp (Hyperdash on HL). Never charging on exits is a trust and safety point. |
| Approval requested | **maxFeeRate = 50** perps, **0** spot | Ask only for what we charge. The only existing SoDEX builder asked for the 20 bp cap. Contrasting with that is a marketing point. |
| Manual trading (Trade page) | **0 bp** for launch (collect approval anyway) | Builds habit. SoDEX already charges 4 bp taker. |
| Spot | **0** | Tiny volume, and sells only |
| Analytics (Explore, Leaderboard, Scan) | **Free** | Every competitor is free. Paywalling analytics would starve the copy funnel. |
| Leaders | **30% of builder fees** from their followers. Profit-gated. Paid weekly in vUSDC after they claim the address. | Binance norm is 10% of fees + up to 30% of profit. Our share of fees is generous because it is our only lever, and it recruits SoDEX's top traders. |
| SoDEX referral / Squad | ValueDesk referral code on the sodex.com registration step | +10% of referees' fees, +25% of their SoPoints, Squad boost. **Owner action:** needs $1,000 SoDEX volume to unlock the code. Early-Bird deadline 2026-09-29 12:00 UTC. |
| Revenue expectation | $1–5M/day copied on SoDEX (0.7–3.5% share) → **$7.5k–37.5k/mo gross** at 2.5 bp effective, **$5.3k–26k net** after the 30% leader share | Enough to cover infra. The goal is share, not profit. |

**Do not charge at launch:** analytics subscriptions, performance fees, manual-trade builder fees, spot fees, closes/exits, deposits, withdrawals, leader listing. **No token or points promises** (securities and farming risk). **No fund-moving keys, ever.**

### Phase 2 — Growth (months 3–9, add Hyperliquid)

| Line | Price | Reasoning |
|---|---|---|
| HL copy | **5 bp on opens, 0 on exits** (approve `f` max 50 = 0.05%) | At market (Copin). Cheaper than Hyperdash (5 bp both sides). |
| HL manual trading | **2.5 bp** (Based level), tiered down to 1 bp at >$10M 14D | Terminal norm is 1–5 bp |
| SoDEX manual trading | **1 bp** | Start monetising the habit |
| Leader program v2 | 30% base, **up to 50%** for leaders with >$1M followed equity. Plus an optional **leader surcharge 0–5 bp**, passed through 100%. | Competes with CEX lead-trader economics |
| Pro tier | **$19/mo or $190/yr, paid on-chain** (USDC on ValueChain / Base / Arbitrum). **Auto-granted** to any wallet whose trailing-30D builder fees are ≥ $19. | Pro includes real-time alerts (Telegram/push), "what if I had copied X" backtests, multi-leader portfolios, CSV export, and −1 bp copy fee. Auto-grant means active traders never see a paywall. On-chain verifiable: a `Subscriptions` contract `expiresAt(address)` read by `eth_call` (owner go needed to deploy), or simply a signed payment-tx check. |
| HL referral code | Stack 10% of referees' fees | Phantom shows referrals are worth about 9% on top of builder fees |
| Leader payouts on-chain | Merkle distributor on ValueChain EVM | "On-chain verifiable" story. **Owner go + audit.** |
| Revenue expectation | SoDEX $5M/day + HL $10M/day at ~2.5 bp effective, 30% leader share → **~$79k/mo net** | Illustrative, not a forecast. Hyperdash, the HL leader, grosses about $208k/30d. |

### Phase 3 — Scale (months 9+)

| Line | Price | Reasoning |
|---|---|---|
| Data API | **Starter $99, Growth $299, Pro $999/mo** (free 100 req/day) | Undercuts HyperTracker ($179/$499/$1,159) and sells **SoDEX + HL cross-venue** trader data nobody else has. Pairs with HL `builder_fills` analytics. |
| Performance-fee vaults / escrow | Leader-set **0–20% HWM** performance fee. **Platform takes 20% of it.** | Option D (escrow) on SoDEX. Option F (HyperEVM vault) on HL. **Legal review + audit + owner go** before any deployment. |
| B2B / white-label copy engine | Revenue share: partner keeps 50–70% of builder fees on their users | Distribution is what makes builder revenue (Phantom, MetaMask). Wallets and SoSoValue's 10M-user app are the prize. |
| More venues | Same builder model (Aster, Lighter, dYdX builder codes) | |
| Points programme | Only if legal is comfortable. Fee discounts, not tokens. | |

### Why these numbers (summary)

- **5 bp is the market-clearing copy fee on HL.** Opens-only makes us cheaper than every HL copy product while matching the headline rate.
- **SoDEX's lower base taker fee (4.0 vs 4.5 bp) plus SoPoints** make SoDEX copying cost-competitive even with our fee.
- **Free analytics is table stakes.** We monetise **execution and data access**, never **viewing**.
- **Leader pay comes from our own fees**, so it never touches follower funds and keeps the Opentrade "key cannot move funds" guarantee intact.

---

## 5. Facts table

| # | Claim | Confidence | Source |
|---|---|---|---|
| 1 | SoDEX builder fee caps: perps 200 (0.2%), spot 2000 (2%), units tenths of bp | documented | sodex.com/documentation/…/builder-codes-in-trading |
| 2 | SoDEX builder fees apply to both sides of perps, **not the buy side of spot** | documented | same |
| 3 | SoDEX builder needs ≥100 vUSDC in Spot **and** Perps. Builder ID = account ID. | documented | same |
| 4 | Max 10 active builder approvals per user (SoDEX and HL) | documented | SoDEX doc; hyperliquid-docs/trading/builder-codes |
| 5 | SoDEX builder approval must be signed by the master wallet | documented | SoDEX builder doc; api-keys-and-nonces |
| 6 | SoDEX builder fees credit in real time, no claim step. Per-fill `builderFee` / WS `bf`. | documented | SoDEX builder doc |
| 7 | `builder` and `permissions` are mutually exclusive in one API-key registration | documented | SoDEX builder doc |
| 8 | Max **5 API keys** per SoDEX master account | documented | sodex.com/documentation/…/trading/api-keys-and-nonces.md |
| 9 | `GET mainnet-gw.sodex.dev/api/v1/user/{addr}/builders` is public (no auth) | verified | curl 2026-09-25 |
| 10 | Only 4 of the top-500 SoDEX 30D-volume wallets have builder approvals, all to builder 223169 (spot 500, perps 200) | verified | 500 calls to the above endpoint + `mainnet-data.sodex.dev/api/v1/leaderboard` |
| 11 | Builder 223169 = EOA 0x6dc379a4…8f0d, holds 100 vUSDC perps / 432.88 vUSDC spot | verified | `eth_call` 0x792713b8 on 0x0101…0101; gateway balances |
| 12 | SoDEX perps volume ≈ $4.35B / 30D (≈ $140M/day, range $44M–$601M). Spot ≈ $45M / 30D. | verified | `mainnet-data.sodex.dev/api/v1/dashboard/volume` 2026-08-25..09-24 |
| 13 | SoDEX 30D leaderboard contains 134,605 wallets | verified | leaderboard API `total` |
| 14 | SoDEX base fees tier 0: perps 0.040%/0.012%, spot 0.065%/0.035%. 14D window. Weighted vol = perps + 2×spot. | verified + documented | Opentrade `web/src/fees.ts:31-84`; trading-fees.md |
| 15 | SoDEX Perps protocol fees ≈ $284.9k / 30D, $1.66M lifetime | reported | api.llama.fi/summary/fees/sodex-perps |
| 16 | HL builder caps 0.1% perps / 1% spot. Builder needs 100 USDC perps value. Sell-side-only on spot. | documented | hyperliquid-docs/trading/builder-codes |
| 17 | HL per-builder fills published daily at stats-data.hyperliquid.xyz/Mainnet/builder_fills/{addr}/{YYYYMMDD}.csv.lz4 (public, not requester-pays) | verified | HEAD 200, 1.17MB for Phantom 2026-09-24 |
| 18 | Phantom HL builderRewards = $26,309,468. Referral code PURPS, 183,423 referrals. Claimed + unclaimed $28.64M. | verified | HL info `{"type":"referral"}` for 0xb841…f80b |
| 19 | Insilico HL builderRewards = $4,053,266 | verified | HL info referral for 0x2868…8a39 |
| 20 | HL main-dex perps 24h notional ≈ $7.16B (234 assets) | verified | HL info `metaAndAssetCtxs` |
| 21 | 116 HL interface builders (ex-tradeXYZ) earned ≈ $8.52M / 30D. HL Perps protocol fees ≈ $71.9M / 30D. | reported | api.llama.fi/overview/fees |
| 22 | Copy builders 30D fees: Hyperdash $208k, pvp.trade $14k, HyperX $10k, Katoshi $121, Nansen Perps $3.5k | reported | api.llama.fi |
| 23 | Builder fees charged: Phantom 5 bp, Based 2.5, PVP ~3.8, MetaMask 10, Insilico 1, Axiom 1, Tread.fi 2, Mass 5.5 | reported | CoinGecko/HyperTracker snapshot 2026-05-25 |
| 24 | Hyperdash copy: 0.05% builder fee. API key (180-day) or created wallet. Up to 10 targets. Perps only. Copy volume not rebate-eligible. | documented | docs.hyperdash.com/copy-trade |
| 25 | Copin charges 0.05% on opening size for HL copy | reported | search summary of docs.copin.io fee docs, hyperliquidguide.com |
| 26 | Nansen HL builder fee 8/5/3/2/1 bp by points tier. Pro $49/mo annual, $69 monthly. | documented | academy.nansen.ai articles |
| 27 | HyperTracker API $179/$499/$1,159/$2,399/mo. CoinGlass $29–$699. Hydromancer $300–$2,500. | reported | coinmarketman.com/blog/hyperliquid-data-providers-compared (2026-03) |
| 28 | HL referral: 10% of referees' fees (first $1B), referee −4% (first $25M), unlock at $10k volume | documented | hyperliquid-docs/referrals.md |
| 29 | HL legacy vaults: 10% profit share, leader ≥5%, 10k USDC creation fee. Successor = HyperEVM/CoreWriter vaults. | documented | hyperliquid-docs/hypercore/vaults(.md) |
| 30 | CEX leader shares: Binance ≤30% (+10% of fees), Bybit 10–15%, OKX 8–13%, Bitget futures ≤20% | reported | exchange help centres via search |
| 31 | SoDEX referral (mainnet since 2026-01-01): 10% fee rebate + 25% of invitees' points. Unlock at $1,000 volume. | documented | sodex-support.zendesk.com article 14761887936399 |
| 32 | SoDEX Layer 1 Season: from 2026-09-01, 20 weeks, 900k SoPoints/week, Squad boosts to +25%, Early-Bird +20% until 2026-09-29 12:00 UTC | documented | sodex.com/documentation/sopoints/layer-1-season.md |
| 33 | 150M SOSO ecosystem incentive allocation. SOSO $0.3143 (mcap $107.5M). | reported + verified price | Decrypt/Chainwire launch PR; CoinGecko simple price API |
| 34 | No public SoDEX builder-grant programme found | inferred (absence) | SoDEX docs index llms.txt, support centre, search |
| 35 | SoDEX has no user-signed transfer. Fund movement needs a key with TRANSFER/WITHDRAW bits. | verified (code) | Opentrade README "Moving money"; `server/src/signing/actions.ts:53` |
| 36 | SoDEX-specific trackers exist (SoDEX leaderboard, CommunityScan Sodex, SodexTracker), none with copy trading | verified (sites/APIs) + reported | communityscan-sodex.com; github.com/EliasD87/SodexTracker |
| 37 | SoDEX fee income / volume implies ~0.65 bp average. Headline volume overstates fee-paying taker flow. | inferred | items 12 + 15 |

---

## 6. Open questions (and how to verify)

1. **What permission mask does a key created with `AddAPIKeyWithBuilder` get?** If it can transfer or withdraw, it must never be used for copying. Verify on **testnet** (chain 138565) with a throwaway account, then read back `GET /api/v1/user/{addr}/api-keys`. This is a signed request, so it **needs an owner go**.
2. **Can a SoDEX builder transfer vUSDC to another user's account directly** (for leader payouts), or must it go Perps→Spot→ValueChain EVM→ERC-20 transfer? `transferAsset` enum semantics for cross-user transfers are unclear. Check with the Go SDK and a testnet run (owner go).
3. **Is the builder fee on top of the exchange fee on SoDEX, and does it apply to maker fills?** The docs are silent. HL is additive. Verify from the `builderFee` field on a real fill; this needs a funded account.
4. **Is SoDEX dashboard volume single- or double-counted,** and how much is zero-fee MM/incentive flow? Compare against the sum of per-wallet leaderboard volumes (2,693 pages; do it slowly) or ask SoDEX.
5. **Can referral binding happen off sodex.com** (API or mirror-deposit path), and do referral rebates apply to API/builder-routed orders? Not documented. Ask SoDEX BD, or test with one real registration (owner go).
6. **Will SoSoValue grant anything?** Candidate asks: ecosystem-pool grant, SoPoints boost for builder-attributed volume, CORS allowlist for `sodex.com/auth/v2/*`, featured placement, a KOL-level referral rate. Needs a BD conversation.
7. **Does ValueChain EVM have a CoreWriter-like path for contracts to trade on SoDEX?** This decides whether on-chain copy vaults or performance-fee vaults are possible on SoDEX at all (Option G). Cross-reference the contract-architecture report.
8. **Copin, Hyperbot and Katoshi exact subscription prices.** They sit behind login or Cloudflare. A manual browser visit resolves this.
9. **Who is builder 223169?** Low priority. Its approvals appear on only 4 wallets.

---

## 7. Recommendations for ValueDesk

1. **Build builder-code support into the onboarding flow from day one.** After deposit, the user signs `addPermissionedAPIKey(mask=3)` and then `approveBuilderFee(builderID=<ours>, maxFeeRate=50)`. Show "max 0.05%, only on opening trades, revoke any time", with a one-click revoke (`maxFeeRate: 0`).
2. **Create the ValueDesk builder account** on SoDEX: 100 vUSDC spot + 100 vUSDC perps, about $200 locked. Create the HL builder account the same way (100 USDC perps). Use a **hardware-wallet EOA** and sweep revenue regularly. **Owner action: it involves real funds.**
3. **Owner decision now:** create the SoDEX referral code and Squad before **2026-09-29 12:00 UTC** for the +20% Early-Bird boost. This needs $1,000 of SoDEX volume on the owner's account. Put the referral link on the "register on sodex.com" onboarding step.
4. **Instrument revenue from fills, not balances.** Persist `builderFee`/`bf` per fill with a leader attribution. This one table drives leader payouts, the Pro auto-grant and the public revenue dashboard.
5. **Ship the leader programme with the launch.** 30% of builder fees, profit-gated, claim-by-signature. Publish a weekly CSV. Move to a Merkle distributor on ValueChain once the owner approves a deployment.
6. **Keep Explore, Leaderboard and Scan free, and index SoDEX more deeply than anyone** (hourly leaderboard → per-trade analytics). Use HL `builder_fills` to publish a "copy-platform leaderboard" and to track competitors' volumes for free.
7. **Open a BD channel with SoSoValue/SoDEX.** Pitch: first serious builder, bringing copy-flow volume. Asks: grant from the 150M SOSO pool, SoPoints boost for builder-attributed volume, CORS allowlist, co-marketing.
8. **Do not deploy anything, and do not ask users for transfer or withdraw permissions.** Performance fees wait for the escrow-contract design, an audit, legal review and an explicit owner go.
