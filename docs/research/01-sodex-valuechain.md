# 01 — SoDEX + ValueChain capabilities for ValueDesk (copy trading)

Research date: 2026-09-25 (all "verified" facts observed live that day from a machine in Germany, read-only).
Scope: what SoDEX / ValueChain can and cannot do for (1) tracking and analysing trader addresses and (2) copy-trading
them through an on-chain contract. No transactions, no signed requests, no deployments, no cloud resources were used.
Everything live was public GET/POST info queries, `eth_call` simulations (including state-override simulations) and
public docs. One third-party measurement service (Globalping, public anonymous API) was used for the latency map.

Confidence labels: **verified** = observed live or in code, **documented** = official SoDEX docs/SDK,
**inferred** = reasoned from verified facts, **assumption** = not checked.

---

## TL;DR

1. **A smart contract cannot trade on SoDEX.** Every trading, API-key and builder action is authorised by an
   ECDSA secp256k1 signature over an EIP-712 digest (`0x01` + engine domain `spot`/`futures`, or `0x02` + `universal`
   domain) that the gateway *recovers* to an address. No ERC-1271 path is documented, the appchain transactions carry
   raw 65-byte ECDSA signatures (we recovered the signer of live transactions and matched it to registered API keys),
   and the only on-chain "execute" entry point (`SoDexTokenCallForPermit.execute`) uses `ECDSA.recover` and only
   supports six EVM-side commands (withdraw, bridge, deposit-with-permit, 3 vault ops) — **no order placement, no
   API-key registration**. The copy "contract" can therefore only be a **registry / policy / fee layer**; execution
   must be done by an off-chain executor that holds a user-authorised API key.
2. **What a contract *can* do on ValueChain:** deposit funds *into any already-activated* SoDEX account (spot or
   perps) via `ClobGateway.depositERC20(token, amount, recipient, destination)` — verified by `eth_call` simulation,
   including with a contract as `msg.sender`. It cannot pull funds back out (withdrawals are appchain actions signed by
   the account key and settled by a sequencer system tx `releaseFund` from `0xdEad…0000`).
3. **API-key permission semantics are the opposite of what Opentrade assumes.** Current docs and the Go SDK (commit of
   2026-07-13) say `permissions` is a **disable** mask (`TRADE=1, CANCEL=2, WITHDRAW=4, TRANSFER=8`, a set bit
   *disables*), and a permissioned key **must disable TRADE or CANCEL** ("enabling both TRADE and CANCEL is not
   supported"). So a **"trade+cancel only, cannot withdraw" key cannot be created** today, and Opentrade's
   `mask 3` "safe session key" actually disables trade+cancel and leaves withdraw+transfer enabled. **Flag this to the
   Opentrade codebase owner before anyone uses it on mainnet.** For ValueDesk it means an executor key is an ordinary
   (all-permission) key; its blast radius is "can trade and can move funds between the owner's own spot/perps/EVM
   wallet", not "can send funds to a third party" (withdrawals land on the owner's EVM address).
4. **Trader discovery is fully open.** Every trade print on the gateway WebSocket carries buyer/seller account ids
   (`bi`/`si`); REST trade prints do not. Account id → address is resolvable in bulk
   (`POST https://sodex.dev/mainnet/chain/users/addresses`, 500 ids per call worked) and on-chain
   (`ClobGateway 0x792713b8(accountId) → owner`). `getNextAccountId()` = **230,773** (≈230.8k account ids issued);
   the official leaderboard has **134,605** ranked wallets. All per-account data (state, positions, orders, fills,
   fundings, order/position history, API keys, builder approvals, rate-limit counters) is readable for **any** address
   without auth, over REST and WebSocket.
5. **The real "on-chain" trading record is the CLOB appchain, not ValueChain EVM.** ValueChain EVM (chain 286623,
   ~2.04 s blocks, ~1 tx/block) only records deposits, withdrawals and registrations. Trading happens on separate spot
   and perps appchains (block height ≈ 239.5 M, **~75 ms blocks**); `blockTime/blockHeight` in REST responses are
   appchain values. An undocumented but public **CLOB explorer API** (`clobscan-mainnet.sodex.dev`) returns every
   appchain transaction per block **with the full signed payload** (orders, cancels, nonce, signature), per-account
   action history with cursor paging, and a WS head feed. Perps runs ~220–400 tx/s, ~90 % from one market maker.
6. **Latency: the matching stack is in Tokyo.** All SoDEX/ValueChain hosts sit behind Cloudflare; global probes show
   gateway TTFB **14–15 ms from Tokyo** vs 55 ms Seoul, 77–92 ms Hong Kong, ~100 ms Singapore, 257 ms Frankfurt,
   480–690 ms US. Server-side push delay (block time → WS send) is **median 47 ms (perps) / 17 ms (spot)**. A
   copy executor must run in Tokyo (the owner already has a live Tokyo box per the AWS hard rule — measure from it,
   do not create instances). From Germany the one-way path adds ~120 ms (WS RTT 250 ms).
7. **Monetisation via builder codes is real and simple:** builder = any activated account holding ≥100 vUSDC in
   spot *and* perps; user approves a max fee once with the master wallet (can be bundled into API-key registration
   via `AddAPIKeyWithBuilder` → **one wallet signature onboards the executor key and the builder fee**); fee per order
   ≤ 0.2 % perps / ≤ 2 % spot, credited in real time to the builder account; max 10 approvals per user. No builder
   fee was observed in ~860 sampled live appchain txs (nobody is using it yet). Referral program: 10 % of referred
   users' fees + 25 % of their SoPoints.
8. **Gaps to raise with SoDEX:** user-creatable sub-accounts (the data model has them, `createSubAccount` is
   owner-only and `getNextUserId` ≈ `getNextAccountId` so practically none exist), a trade-only key, per-key
   symbol/notional limits, ERC-1271 support, and higher WS "unique users per IP" limits for a tracker.

---

## 1. Discovering traders

**Trade feed attribution**
- WS `trade` channel (`wss://mainnet-gw.sodex.dev/ws/{spot|perps}`, `{"op":"subscribe","params":{"channel":"trade","symbols":[...]}}`)
  pushes `WsTrade {E, T, t, s, S, p, q, bi, si}` where `bi` = buyer account id, `si` = seller account id; `S` is the
  taker side (`BUY` ⇒ buyer is taker). **Verified**: 671 perps + 154 spot prints in 90 s, 100 % carried `bi`/`si`
  (24 distinct perps account ids and 7 spot ids in that window). One subscription with all 98 perps symbols is acked
  as 98 separate subscriptions (counts against the 1000-subscriptions/IP limit).
- REST `GET /api/v1/{engine}/markets/{symbol}/trades` returns `{t,T,s,S,p,q}` **without** `bi`/`si` (verified), so
  backfilling attribution from REST is impossible; you must record the WS stream (or use per-account history).
- Opentrade already encodes this: `web/src/components/TapeFilter.tsx:8-25`, `web/src/api.ts:197-217`.

**Account id → address at scale** (all verified):
| Method | Endpoint / call | Notes |
|---|---|---|
| Bulk REST (fastest) | `POST https://sodex.dev/mainnet/chain/users/addresses` body `{"userIds":[...]}` | 500 ids in one call returned 500 rows. ~462 calls cover all 230k ids. Used by sodex.com's own explorer chunk `explorerApi-*.js`. |
| Single REST | `GET https://sodex.dev/mainnet/chain/user/{id}/address` | `{userId, address}` |
| Reverse REST | `GET https://sodex.dev/mainnet/chain/address/{addr}/accounts` | `{address, userId, primaryAccountId, subAccountIds}` |
| On-chain | `eth_call` ClobGateway `0x792713b8(uint256 accountId)` → owner address | Unnamed selector; round-trip with `getAccountsByAddress(address)` `0x380e78af`. Multicall3 (`0xcA11…CA11`) is deployed and JSON-RPC batch requests work, so 1000s per call are possible. |
| Gateway | `GET /api/v1/user/{addr}/subaccounts` → `{userID, primaryAccountID, subaccounts[{id, evmAddress}]}` | address → ids |
| Leaderboard | `mainnet-data.sodex.dev/api/v1/leaderboard` rows carry `wallet_address` + `account_id` | 134,605 rows, page_size ∈ {10,20,50} → 2,693 pages at 50 |

**Enumerating all accounts** (verified):
- `ClobGateway.getNextAccountId()` (`0xab00c0da`) = **230,773**; `getNextUserId()` (`0x1c54e565`) = **230,774**.
  Highest id seen in the live trade feed: 230,580. Low ids are system accounts (998 = mirror/bridge withdrawal
  account `0x0151…5A23`, 999 = cross-engine magic id, 1001/1002/23342 = market makers).
- Registration is logged on the EVM chain by ClobGateway: event `0x3b63e732…baba` (`address indexed owner, uint256
  userId, uint256 accountId`; name unresolved) and `CreateSubAccount(uint256 indexed userId, uint256 indexed
  accountId)` (`0xc43b2f2e…8451`). These are emitted inside Mirror deposit processing
  (`SoDexTokenCustody.deposit(tuple)` `0xe38398e2` called by operator `0x24a5…2324`) — i.e. **the first deposit
  creates the account**. Current rate ≈ 23 registrations per 20k blocks (~11 h) ≈ 50/day. `eth_getLogs` accepts up
  to ~20k-block ranges (49,999 rejected) → ~740 calls to scan from genesis.
- Official dashboard (`mainnet-data.sodex.dev/api/v1/dashboard/users?start_date&end_date`) reported 91–310
  new users/day for 2026-09-20…24; `dashboard/tvl` ≈ $78–80 M.

**Measured today:** ≈230.8k account ids issued; 134,605 leaderboard wallets; 24 distinct perps traders active in a
random 90 s window; 11 accounts in 40 sampled perps blocks (one MM, account 23342, = 91 % of actions).

## 2. Per-address data (no auth)

"User-specific streams do not require subscription authorization. Any client may subscribe to another user's
data" (documented, websocket-v1 page) — and verified.

**REST** (base `https://mainnet-gw.sodex.dev/api/v1`, all verified for a leaderboard trader; weight in brackets):
| Data | Path | Limits / notes |
|---|---|---|
| Frontend state | `/{spot,perps}/accounts/{addr}/state` [5] | `aid`, `uid`, `av` (account value), `am`, `mm`, `B` balances, `P` positions, `O` orders, `TO` TWAPs … `?accountID=` for sub-accounts |
| Balances | `/{engine}/accounts/{addr}/balances` [5] | wrapped `{blockTime, blockHeight, balances[]}` |
| Positions | `/perps/accounts/{addr}/positions` [5] | `Position{id,symbol,marginMode,side,size(±),initialMargin,avgEntryPrice,cumOpenCost,cumTradingFee,cumClosedSize,avgClosePrice,maxSize,realizedPnL,leverage,…}` |
| Open orders | `/{engine}/accounts/{addr}/orders` [5] | wrapped |
| Fills | `/{engine}/accounts/{addr}/trades` [20 + n/20] | `limit` default 100, **max 1000**; `symbol, orderID, startTime, endTime`; fields `symbol,tradeID,orderID,clOrdID,side,price,quantity,fee,builderFee,feeCoin,isMaker,time` |
| Order history | `/{engine}/accounts/{addr}/orders/history` [20 + n/20] | default 50, **max 500** |
| Position history | `/perps/accounts/{addr}/positions/history` [20 + n/20] | default 50, **max 500**; includes `realizedPnL` per closed position — best PnL source |
| Funding | `/perps/accounts/{addr}/fundings` [20 + n/20] | default 100, **max 1000** (`/funding-history` 404s) |
| Fee rate | `/{engine}/accounts/{addr}/fee-rate` [2] | `makerFeeRate, takerFeeRate, feeTier, stakingTier, makerRebateTier` |
| TWAPs | `/{engine}/accounts/{addr}/twaps` | |
| API keys | `/user/{addr}/api-keys` (and `/{engine}/accounts/{addr}/api-keys`) [5–20] | names, public keys, `expiresAt`, `permissions` if set |
| Builders | `/user/{addr}/builders` | `{spot:[],perps:[]}` approvals |
| Sub-accounts | `/user/{addr}/subaccounts` | |
| Action quota | `/user/{addr}/ratelimit` [20] | `cumulativeTxNum, cumulativeCancelNum, cumulativeVolume, transactionQuota…` |
| Status | `/user/{addr}/status` | `Active` / `UserNotFound` |

- **History depth:** paging is by `endTime` (inclusive — Opentrade `server/src/history.ts` documents the dedupe
  rules and that `tradeID` is not unique per account). Verified: trader 220959's oldest REST fill (2026-07-08
  11:57 UTC) equals `first_trade_ts_ms` from the data host → full history since account inception is served.
  No explicit retention limit is documented. About 8 % of history pages come back HTTP 200 with an error envelope
  (Opentrade `server/src/sodex/rest.ts:96-134`); retry them.
- **Venue analytics (undocumented data host, verified):** `https://mainnet-data.sodex.dev/api/v1/`
  `leaderboard?window_type={24H|7D|30D|ALL_TIME}&sort_by={pnl|volume}&sort_order&page&page_size∈{10,20,50}`
  (hourly snapshot, `snapshot_ts` 10:00:00Z), `leaderboard/rank?wallet_address=`, `perps/pnl/overview?account_id=`
  (daily snapshot at UTC midnight: `cumulative_pnl, cumulative_quote_volume, unrealized_pnl, first_trade_ts_ms`),
  `perps/pnl/daily_stats?account_id=` (cumulative PnL per day; 80 points for a 2.5-month-old account),
  `dashboard/volume` (per-market daily volume), `dashboard/users`, `dashboard/tvl`. Data-quality warning: the top
  PnL rows (e.g. account 1225, 230k USD ALL_TIME PnL) show `volume_usd` ≈ 0 and `pnl/overview` = 0 — the
  leaderboard PnL evidently includes non-perps components; do not treat it as trading skill without recomputing.
- **SoPoints/referral** (Opentrade `web/src/points.ts`): `alpha-biz.sodex.dev/biz/sopoints/week/info`,
  `biz/referral/public/referralCode?walletAddress=` are public; own points balance needs a SoDEX JWT
  (`sodex.com/auth/v2/nonce|verify`, wallet `personal_sign`).
- **WS account channels** for any address: `accountState`, `accountUpdate`, `accountOrderUpdate`, `accountTrade`,
  `accountEvent` (liquidations), each `{channel, user, accountID?}`. Verified: 14 different users' `accountState` on
  one connection were all accepted and pushed snapshots (~1 per 1.2 s per user). **Documented limits per IP:
  10 concurrent connections, 30 new connections/min, 1000 subscriptions, 10 unique users, 2000 msgs/min per IP and
  per connection, 100 inflight requests.** The 10-unique-users limit was not enforced in our test but must be
  assumed for design (→ tracking thousands of leaders in real time needs the appchain feed, not per-user WS).
- **REST budget:** documented 1200 weight/min/IP (unlisted endpoints default to weight 20). Responses carry
  Cloudflare `x-ratelimit-limit: 6000` / `x-ratelimit-remaining` headers. During this session one burst ended in a
  Cloudflare **`error code: 1015`** block for ~1 min. A full 1000-row history page costs 70 weight →
  ~17 pages ≈ 17k rows per minute per IP.

## 3. On-chain settlement: what is (and isn't) on ValueChain

- **ValueChain EVM** (verified): chain id 286623, `web3_clientVersion` = `Geth/vvalue-geth/1.1.1-stable-f3f4a0ac`,
  average block time 2.042 s, ~1.06 tx/block (mostly 3 addresses sending plain transfers), base fee 0.001 gwei,
  gas price 0.002 gwei. Blockscout at `main-scan.valuechain.xyz/api/v2`.
- **ClobGateway / exchange** `0x0101…0101` ("ValueChainProxy", verified source): Optimism-style EIP-1967 transparent
  proxy; implementation `0xe9532f96…0597` (unverified, 19,068 bytes); proxy admin = `ProxyAdmin 0x0101…0100`;
  **ProxyAdmin owner and ClobGateway `owner()` = Safe v1.4.1 `0x07ad6c2a…82ca` with threshold 1 of 2** (a single key
  can upgrade the exchange). 515,886 lifetime txs. Last 2,000 txs (3.35 days): 1,853 `releaseFund(uint256,address,
  uint256)` from `0xdEad000000000000000000000000000000000000` as **type-0x10 system txs with zero fee**, 147
  `depositERC20` from 120 distinct EOAs (no contract depositors). No `addAPIKey`/`register` user txs anymore.
- Events on ClobGateway: `Deposit(uint256,address,uint256,uint256)` `0xd36a2f67…`, `Withdraw(uint256,address,uint256)`
  `0x9da6493a…`, `CreateSubAccount(uint256,uint256)` `0xc43b2f2e…`, registration `0x3b63e732…`.
  138 logs in 5,000 blocks (~2.8 h). **No fills, orders or positions on the EVM chain.**
- **Trading lives on the spot and perps appchains** of ValueChain's "HostChain" (documented: "A spot order-book
  appchain", "A perpetual order-book appchain", EVM "syschain" as unified account system). REST `blockHeight`
  ≈ 239,537,632 vs EVM block 14,784,923 (verified) → REST/WS `blockTime/blockHeight`/`h`/`T` are **appchain** values.
  Appchain cadence (verified from REST and explorer WS): ~12.6–14 blocks/s ≈ 70–80 ms per block; spot and perps share
  one height sequence.
- **Indexing fills from EVM logs is impossible.** Options instead:
  1. **CLOB explorer REST** (undocumented, found in sodex.com's `explorerApi-*.js`, CORS `*`, verified):
     `https://clobscan-mainnet.sodex.dev/api/v1/{perps|spot}/block?height=` → `{snapshot_id, ts_ms, payload_id, tx_count}`;
     `…/block/transactions?height=` → every tx with `tx_hash, snapshot_id, ts_ms, seq, account_id, cl_ord_ids,
     order_ids, status, msg, tx_json` where `tx_json` = `{type, payload(params), nonce, signature}`;
     `…/transaction?tx_hash=` and `…/transaction?account_id=&order_id=`;
     `…/account/transactions?address=&limit=≤1000&cursor=` (response `meta.next_cursor`, base64 `hot|ts,snapshot,seq`).
     This is the complete *order-intent* firehose (newOrder, cancelOrder, replaceOrder, scheduleCancel,
     batchNewOrder, …) — **not fills**.
  2. **CLOB explorer WS** `wss://mainnet-ws-explorer.sodex.dev/websocket`, `{"method":"SUBSCRIBE","event":"ValueChain_perp_v1"|"ValueChain_v1"|"ValueChain_transaction_perp_v1"|"ValueChain_transaction_v1","params":[]}`,
     gzip binary frames, heartbeat `{"method":"PING"}` → `PONG`. Pushes every block header (`tx_count`) but **only the
     seq-0 transaction of each block** (253 tx messages vs 7,999 txs in 20 s) → a head/trigger signal, not a firehose.
  3. **Gateway** WS `trade` (fills with `bi/si`) + per-account `accountTrade`/`accountOrderUpdate`, and REST history.
- Verified that clobscan signatures are the original API signatures: rebuilding
  `keccak256({"type","params"})` → EIP-712 `ExchangeAction` (domain `futures`, 286623) from `block/transactions`
  and recovering yielded signers `0x5690…2d3b`, `0x88f2…a64a`, `0x122b…1810`, which are exactly the MM's registered
  perps keys `sky-40`, `sky-25`, `sky-58`. (Note: `transaction?tx_hash=` re-serialises `tx_json` with alphabetical
  keys; use the block endpoint for byte-exact payloads.) → We can attribute each action to the API key that signed
  it (bot vs web key detection).
- **Volume** (verified samples): perps 17.5 tx/block, 42 KB JSON/block ≈ 0.53 MB/s ≈ **46 GB/day raw**; spot
  6.5 tx/block, 14 KB/block ≈ 0.18 MB/s ≈ 15 GB/day. Fills: ~7.5 perps + 1.7 spot prints/s ≈ **0.8 M fills/day**
  (~80 MB/day compact). Market makers 23342 (perps) and 1001 (spot) are ~90 % of actions — filter them at ingest.

## 4. On-chain programmability (critical)

**ClobGateway dispatch table — reproduced (44 selectors, solc `PUSH4 sel EQ PUSH dest JUMPI` pattern) and resolved:**

| Selector | Function | Behaviour observed via `eth_call` |
|---|---|---|
| `97feb926` | `depositERC20(address,uint256)` | deposit to caller's spot account; caller must be registered (`0xe7178dd4` otherwise) |
| `1828686a` | `depositERC20(address,uint256,address)` | deposit on behalf (used by CallForPermit) |
| `178a8a98` | `depositERC20(address,uint256,address,uint256)` | on behalf, `destination` 0 = spot, 1 = perps (2 → revert `0xccee40f9`). **Works from any EOA or contract for a registered recipient**; unregistered recipient → `0xe7178dd4` |
| `3e04f75c` | `releaseFund(uint256,address,uint256)` | only sequencer `0xdEad…` (withdrawals to owner's EVM address) |
| `4420e486` | `register(address)` | onlyOwner (`0x118cdaa7` OwnableUnauthorizedAccount) |
| `ae60186b` | `createSubAccount(address)` | onlyOwner (`0x118cdaa7`) — users cannot create sub-accounts on-chain |
| `2b956ff7` | `getUserId(address)` | reverts `0x40298ab1` if unregistered |
| `380e78af` | `getAccountsByAddress(address)` | `uint256[]` |
| `0f6ba5e9` | `getAccountsByUserId(uint256)` | `uint256[]` |
| `57fec993` | `getUserIdByAccountId(uint256)` | |
| `792713b8` | *(unnamed)* accountId → owner address | |
| `ab00c0da` / `1c54e565` / `541fa9e7` | `getNextAccountId()` 230,773 / `getNextUserId()` 230,774 / `getNextAssetId()` 48 | |
| `54ed5933` | `revokeAPIKey(uint256,string)` | legacy on-chain key path; not used in recent txs |
| `d6abe642`, `eac8f5b8`, `db136b1e`, `9ce017e1`, `dfe15bac`, `984adfeb` | `getAssetId(address)`, `getAsset(uint256)`, `createAsset(address,uint256)`, `createAsset(address)`, `setMinDepositAmount(address,uint256)`, `getMinDepositAmount(address)` | asset registry |
| `3dbb946e` | `WSOSO()` → `0x5050…5050` | |
| `893e9693` | *(unnamed)* → `0xdEad…0000` (sequencer/releaser) | |
| `79330ac0` | *(unnamed)* → 7 whitelisted operator contracts: SoDexTokenPortal `0x07e2…E7C8`, SoDexTokenCustody/Mirror `0xB372…70CB`, 3× Airdrop, SafeL2 `0x56a9…2f5f`, Distribute `0x8517…4167` | |
| `8da5cb5b`, `f2fde38b`, `715018a6`, `c4d66de8`, `61bd3678` | `owner()` = Safe 1-of-2, `transferOwnership`, `renounceOwnership`, `initialize(address)`, `initialize_v2()` | |
| `dc934090 de916daa e0cae709 b011652f bb21c7dd c75e92d5 996df34c a3857b01 8b53c6b9 9190a966 6407481f 7eae74d2 421d7f00 3bc44107 167afae7` | unresolved | views returning bool/0/uint, or owner-only setters (`e0cae709` → `0x118cdaa7`) |

**The `execute(…, cmdType, …)` smart-account path** is **`SoDexTokenCallForPermit`** (`0x890B…7801`, impl
`0xbb72…2Db7`, verified source), reached from `SoDexTokenPortal.callForPermit()`:
`execute(address to, string cmdType, bytes cmdData, uint256 nonce, uint256 deadline, bytes signature)`;
`account = ECDSA.recover(digest, signature)` (no ERC-1271/SignatureChecker anywhere in the source). cmdTypes:
`WithdrawToken`, `CreateBridgeCallFor`, `DepositERC20WithPermit` (permit → `ClobGateway.depositERC20(token,amount,
account)`), `VaultDepositWithPermit`, `VaultDepositWithPermit2`, `VaultRedeemWithPermit`. **No order placement, no API
key registration.** It is the gas-sponsored path the gateway uses for "Sponsored Withdrawal".

**Signature types** (documented + verified in code/live txs): `0x01` = EIP712 with engine domain
(`spot`/`futures`, chainId 286623, verifyingContract 0) for `ExchangeAction{payloadHash, nonce}` — orders, cancels,
transfers, leverage, `revokeAPIKey`; `0x02` = EIP712_UNIVERSAL (`universal` domain, `chainId` = the `X-API-Chain`
header, i.e. the wallet's chain) for `AddAPIKey`, `AddAPIKeyWithBuilder`, `UserSignedAddPermissionedAPIKeyAction`,
`ApproveBuilderFeeAction`. Wire format `type || r || s || v(0/1)`. The master wallet may also sign trading actions
directly (omit `X-API-Key`).

**Verdict:**
- A contract **cannot own a *usable* SoDEX account** (it can never produce the ECDSA signatures needed to trade,
  add keys or withdraw). If funds are ever deposited to an account whose owner is a contract (e.g. via a Mirror
  deposit address issued for a contract address), assume they are stuck. **Never do this.**
- A contract **can** fund followers' accounts (deposit-on-behalf into spot/perps), hold/stream fees on ValueChain,
  store leader/follower subscriptions and risk policies, and be called gas-free through the Transaction Relayer
  (allowlisted integrations only, `POST https://mainnet-gw.sodex.dev/api/v1/relayer/tx`, 2/s, 10/5 min, 50/h per IP;
  access via a SoDEX Discord/Telegram moderator).
- Use EIP-7702 / Simple7702Account (deployed at `0x4Cd241E8…66c9` and `0xa46cc63e…56B5`) only if the user keeps the
  EOA key — 7702 does not remove the ECDSA requirement.
- Account activation: first deposit of USDC or SOSO (costs 1 USDC / 1 SOSO) through Mirror/Gateway; direct
  `ClobGateway` deposits to an unregistered address revert.

## 5. API keys

| Property | Value | Confidence / source |
|---|---|---|
| Register | `POST /api/v1/user/{addr}/api-keys` (universal `0x02` sig by master wallet; `X-API-Chain`, `X-API-Sign`, `X-API-Nonce`); body `{accountID, name, type:1, publicKey(EVM address), expiresAt(ms), builder? | permissions?}` | documented (public API page). Opentrade uses `POST /api/v1/{engine}/accounts/api-keys` (`server/src/routes/wallet.ts:651`) |
| Name | `^[0-9a-zA-Z_-]{1,36}$`, not `default`; sent as `X-API-Key` | documented |
| Max keys | **5 per master account** | documented; **but** MM account 23342 has ~51 spot and ~100 perps keys (verified) → limit is overridable for some accounts |
| Keys per engine | spot and perps key lists are separate; registration must succeed on both | documented + verified (different key sets per engine) |
| Expiry | `expiresAt` ms, `0` = never; sodex.com's own keys on a sampled account: `webkey` expires ~6.8 d after the sample, `mobilekey` already expired (2026-09-04) but still listed, `default` = master address, never expires | verified |
| Permissions | bit mask, **set bit DISABLES**: `TRADE=1` (place/replace/modify/cancel, leverage, margin), `CANCEL=2`, `WITHDRAW=4` (spot/perps → EVM **or the other engine**), `TRANSFER=8` (sub-account/internal) | documented (schema `APIKeyPermissionEnum`) + Go SDK `common/enums/api_key_permission.go` (2026-07-13) |
| Permissioned-key constraint | must disable TRADE, CANCEL or both; `builder` and `permissions` mutually exclusive | documented |
| Revoke | two calls: `DELETE /api/v1/spot/accounts/api-keys` and `DELETE /api/v1/perps/accounts/api-keys`, each `0x01` engine-domain signature by the **master wallet**, body `{accountID, name}` | documented (Opentrade uses `POST …/accounts/api-keys/revoke`, `wallet.ts:749`, `elevation.ts:166` — verify) |
| Nonces | per signing address, highest 100 kept, must be in `(T−2d, T+1d)` ms | documented |
| Symbol / notional restrictions | **none exist** | documented (no such fields) |
| Can a third party hold a user's key? | Yes — any holder of the key's private key can sign for that account. Only an ordinary (all-permission) key can trade. | documented + inferred |

**Consequences for ValueDesk:**
- The executor will hold ordinary keys ⇒ it can trade, cancel, set leverage, move funds spot↔perps↔owner's EVM
  wallet. It **cannot** send funds to a different owner: EVM withdrawals credit the owner's own EVM address, and
  external withdrawals need the owner's ECDSA `WithdrawToken` permit; internal transfers are "not supported yet".
  Residual risk = adversarial trading (e.g. wash trading into an attacker's resting orders on thin markets). Mitigate
  with short `expiresAt` (e.g. 7–30 days, re-authorise), per-user risk limits enforced in the executor, market
  whitelists (liquid markets only), and slippage-bounded IOC orders.
- **Opentrade bug (critical, not fixed here):** `server/src/signing/actions.ts:53-55` and
  `server/src/routes/wallet.ts:53` use `permissions = TRADE|CANCEL = 3` believing it enables trade+cancel; per current
  docs/SDK it disables them, leaving WITHDRAW and TRANSFER enabled. NOTES.md:227 and :241 and README "session key
  cannot move funds" are therefore wrong under the current protocol. Verify by reading `permissions` of a key created
  by Opentrade via `GET /api/v1/user/{addr}/api-keys`.

## 6. Sub-accounts

- Data model exists (documented + verified): `GET /api/v1/user/{addr}/subaccounts` → `{userID, primaryAccountID,
  subaccounts[{id, evmAddress}]}`; every account query and WS channel takes `accountID`; API keys can be scoped to a
  sub-account (`AddAPIKeyRequest.accountID` = "primary or subaccount ID"); a master can hold keys for sub-accounts.
- **Creation is not user-accessible:** ClobGateway `createSubAccount(address)` is `onlyOwner` (verified revert
  `0x118cdaa7`); no REST endpoint is documented; the sodex.com bundle has no sub-account page. `getNextUserId`
  (230,774) ≈ `getNextAccountId` (230,773) → effectively **no sub-accounts exist** in production.
- Transfers: `TransferAssetRequest{id, fromAccountID, toAccountID, coinID, amount, type}` with `INTERNAL=4`, but both
  engine pages state "Internal transfer … is not supported yet". Cross-engine uses `toAccountID=999`.
- ⇒ **Per-leader isolation via sub-accounts is not available today.** Fallbacks: one follower account following
  several leaders with executor-side netting (perps is one-way/netted per symbol — `PositionSide` only `BOTH`), or
  one leader per follower wallet. Ask SoDEX for sub-account creation (it is clearly on their roadmap: API supports it).

## 7. Builder codes (complete)

Source: `https://sodex.com/documentation/for-developers/developers/trading/builder-codes-in-trading.md` plus the
Public API and Schema pages (all documented).
- **Eligibility:** any *activated* account with ≥ **100 vUSDC in Spot and ≥ 100 vUSDC in Perps** (checked on approval
  *and* on clearing). No registration; builder id = the account id (`/user/{addr}/subaccounts → primaryAccountID` or
  `state.aid`).
- **Units:** tenths of a basis point. `10` = 1 bp = 0.01 %; `50` = 0.05 %; `200` = 0.2 %; `2000` = 2 %.
  Approval `maxFeeRate` 0–2000; per-order `fee` must be ≤ approval **and** ≤ engine cap (**spot 2000, perps 200**).
- **Scope:** only fees collected in the **quote/collateral asset** — not the buying side of spot trades; both sides of
  perps trades.
- **Approval:** `POST /api/v1/user/{addr}/builders`, body `ApproveBuilderFeeRequest{accountID (primary),
  builderID, maxFeeRate}`, master-wallet signature, EIP-712 `ApproveBuilderFeeAction(uint64 chainID,uint64 nonce,
  uint64 accountID,uint64 builderID,uint64 maxFeeRate)`, domain `{name:"universal", version:"1",
  chainId:<X-API-Chain>, verifyingContract:0x0}`, message `chainID` = 286623 (mainnet) / 138565 (testnet), prefix
  `0x02`, `v` normalised to 0/1, same nonce in message and `X-API-Nonce`. Must succeed on both engines; queries may
  lag. `maxFeeRate: 0` clears. **Max 10 active approvals per user.**
- **Combined onboarding:** `POST /api/v1/user/{addr}/api-keys` with `builder:{id, fee}` and EIP-712
  `AddAPIKeyWithBuilder(uint64 chainID,uint64 nonce,uint64 accountID,string name,uint8 keyType,bytes publicKey,
  uint64 expiresAt,uint64 builderID,uint64 maxFeeRate)` → **one master-wallet signature registers the executor key
  and approves our fee.** (Ordinary `AddAPIKey(uint64 accountID,string name,uint8 keyType,bytes publicKey,uint64
  expiresAt,uint64 nonce)` has no message `chainID`.)
- **Query:** `GET /api/v1/user/{addr}/builders` → `{spot:[{userID,builderID,feeRate}], perps:[…]}`.
- **Orders:** `BuilderParams{id (non-zero), fee}` placed **last** in its structure, `id` before `fee`, included
  **before** computing `payloadHash`. Spot: batch-level `builder` after `orders` in `BatchNewOrderRequest`. Perps:
  `PerpsNewOrderRequest.builder` as batch default, per-order overrides allowed. Orders with an unapproved builder are
  rejected. Order objects echo `builder{builderID, feeRate}`; WS order `b{i,f}`; fills `builderFee` (REST) / `bf` (WS).
- **Payout:** credited **in real time** to the builder account on the engine that produced the fill; no claim.
  Monitor via `accountUpdate` on the builder account (`B[].t` spot, `B[].wb` perps) or balances REST. Withdraw via
  normal flow Perps → Spot → ValueChain EVM → external (Sponsored Withdrawal).
- **Adoption:** 0 builder-tagged txs in 862 sampled live appchain txs; top leaderboard trader has no approvals
  (verified) → green field.
- **Other programmes:** Referral (support article 2026-01-01): referrer gets **10 % of referred users' fees** +
  **25 % of their SoPoints** after 1,000 USDC own volume; invitee gets 5 % points boost; payout asset/frequency not
  specified. SoPoints: weekly pool 1,000,000 (Opentrade `points.ts` RULES), snapshot Sat 00:00 UTC. Wealth vault
  referrals are a `bytes32` on vault requests (not CLOB). Relayer gas sponsorship for allowlisted integrations. No
  public builder grant programme found.

## 8. Gateway hosting & latency

- **DNS (verified):** `mainnet-gw`, `testnet-gw`, `mainnet-data`, `alpha-biz`, `sodex.dev` → `104.17.90.73`,
  `104.17.91.73`; `rpc`/`main-scan`/`testnet-rpc.valuechain.xyz` → `104.18.30.138`, `104.18.31.138`; `sodex.com` →
  `104.18.14.161`, `104.18.15.161`. All **Cloudflare (AS13335)** (`Server: cloudflare`, `CF-RAY …-FRA`). Origin IPs
  are hidden → matching against AWS/GCP ip-ranges is not possible read-only. Traceroute from here ends at Cloudflare
  `2606:4700::6811:5b49` in 9 hops / ~8 ms (Deutsche Telekom → Cloudflare Frankfurt).
- **Origin region (verified via Globalping HTTPS probes, TTFB to `/api/v1/perps/markets/mark-prices`):**
  Tokyo 14–15 ms (CF NRT), Seoul 55 ms, Hong Kong 77–92 ms, Singapore 97–103 ms, Frankfurt 257 ms, San Jose 479 ms,
  Sydney 548 ms, Mumbai 579 ms, Ashburn 693 ms. RPC, clobscan and data hosts show the same Tokyo-minimum pattern
  (30–41 ms Tokyo). ⇒ **Matching engine, gateway and ValueChain nodes are in or next to Tokyo** (inferred; the cloud
  provider is unknowable while behind Cloudflare — could be AWS ap-northeast-1, GCP asia-northeast1 or bare metal).
- **From this machine (not representative):** local clock ≈ +420 ms ahead (measured against Cloudflare trace and WS
  ack `time_out`). TCP to CF edge 24 ms, REST TTFB ~310 ms, WS RTT 248–254 ms, corrected one-way push ≈ 120 ms.
- **Server-side delay:** WS trade `E − T` (send time − block time) median 47 ms / p90 70 ms (perps), 17/25 ms (spot);
  explorer WS block headers arrive ~180 ms after block timestamp in Germany (≈ 60 ms + path).
- **Copy-latency budget from Tokyo (inferred):** leader fill in block N → WS push +20–50 ms → our decision ~1 ms →
  POST to NRT edge ~2 ms + origin ~10 ms → next appchain block (~75 ms) ⇒ **≈ 100–200 ms leader-fill → follower
  inclusion**. From Frankfurt add ≥ 250 ms. Using the leader's *order placement* (`accountOrderUpdate` NEW, or the
  appchain order tx) instead of the fill can move us ahead of partial fills of resting leader orders.
- Keepalive: send `{"op":"ping"}` < 60 s (server drops after 60 s of silence); `trade`/`ticker`/`markPrice`/
  `bookTicker` require `symbols[]`, `l2Book`/`l4Book`/`candle` require `symbol` (Opentrade `server/src/sodex/ws.ts:36-55`).
  `l4Book` currently returns price levels only (no order/account ids) — verified.

## 9. Fees & order mechanics

- **Base fees (verified from `/markets/symbols` + documented tiers):** perps maker **0.012 %** / taker **0.040 %**
  (all 98 perps markets); spot maker 0.035 % / taker 0.065 % (42 of 43 markets; one 0/0).
  Perps tiers (14D weighted volume = perps + 2 × spot): T0 ≤ $5 M 0.040/0.012 · T1 > $5 M 0.036/0.010 ·
  T2 > $25 M 0.032/0.006 · T3 > $100 M 0.028/0.002 · T4 > $500 M 0.026/0 · T5 > $2 B 0.024/0 · T6 > $7 B 0.022/0.
  Spot: 0.065/0.035 → 0.055/0.025 → 0.045/0.015 → 0.035/0.005 → 0.03/0 → 0.025/0 → 0.02/0.
  Staking discount 5 % (≥30 SOSO) … 40 % (≥1.5 M SOSO); maker rebates −0.001/−0.002/−0.003 % at > 0.5/1.5/3 % of
  14D maker volume. Per-account effective rates: `GET /{engine}/accounts/{addr}/fee-rate`.
- **Markets (verified):** 98 perps (91 TRADING, 7 HALT; max leverage 3–40×, BTC/ETH 40×; funding every 3600 s,
  cap ±4 %), 43 spot. 24 h volume ≈ $104 M perps (BTC $54 M, ETH $30 M), ≈ $1.5 M spot; perps OI ≈ $171 M.
- **Order types:** LIMIT, MARKET (must be `IOC`; `funds` only for market buys; optional `price` as slippage cap),
  TIF `GTC`/`IOC`/`GTX` (post-only; may partially fill then reject), **`FOK` not supported**; `reduceOnly`;
  TP/SL triggered by **MARK_PRICE only** (LAST/INDEX not yet), attached brackets (`BRACKET` + `ATTACHED_STOP`, batch
  of 2–3), position TP/SL (`STOP`, global if no qty), standalone stops; TWAP 5–1440 min, 30 s slices, 3 % max
  slippage; modify (perps), replace, `scheduleCancel` (dead-man switch); leverage & isolated margin updates.
  Perps is **one-way / netted** (`PositionSide` only `BOTH`).
- **Batch & filters:** ≤ **100 orders per batch** (spot and perps); weight `1 + floor(N/40)`; price must be on
  `tickSize`, qty on `stepSize`; `minNotional` **10 USD perps / 5 USD spot** (BTC max notional 4 M); limit price band
  `markPrice × (1 ± buyLimitUpRatio/sellLimitDownRatio)` (BTC 5 %), market price bound
  `indexPrice × (1 ± marketDeviationRatio)` (BTC 2.5 %); reduce-only orders skip the notional filter. Decimal
  strings must be canonical (no trailing zeros, no exponent). `clOrdID` `^[0-9a-zA-Z_-]{1,36}$`, unique among open
  orders.
- **Order-rate limits (documented):** API key **600 orders/min and 20 orders/s per account**; web 60/min;
  address-based: 1 action per 1 USDC cumulative traded + 10,000 initial buffer, then 1 req/10 s when exhausted
  (cancels: `min(limit+100000, 2×limit)`); max **1000 open orders** per user (spot+perps); batches count N toward
  address limits. `GET /user/{addr}/ratelimit` shows the counters.
- **Copy-sizing implication:** a follower with $100 copying a leader who opens a $500 position on $10 k equity must
  open $5 — **below the 10 USD perps minimum** → minimum follower allocation must be sized so that the smallest
  expected leader order maps to ≥ $10 notional (inferred).

---

## Facts table

| # | Claim | Confidence | Source |
|---|---|---|---|
| 1 | WS `trade` prints carry `bi`/`si` account ids; REST trade prints do not | verified | live WS/REST 2026-09-25; schema `WsTrade`; Opentrade `web/src/components/TapeFilter.tsx:8-25` |
| 2 | `getNextAccountId()` = 230,773, `getNextUserId()` = 230,774 | verified | `eth_call` `0xab00c0da`, `0x1c54e565` on `0x0101…0101` |
| 3 | Official leaderboard lists 134,605 wallets (all windows), hourly snapshot | verified | `mainnet-data.sodex.dev/api/v1/leaderboard` |
| 4 | Bulk id→address: `POST sodex.dev/mainnet/chain/users/addresses` handles 500 ids per call | verified | live; sodex.com `explorerApi-CbGmXmOO.js` |
| 5 | `0x792713b8(accountId)` returns owner; `0x380e78af` = `getAccountsByAddress` | verified | `eth_call`; Opentrade `server/src/sodex/chain.ts:498-500` |
| 6 | Any address's positions/orders/fills/fundings/API keys/builders readable without auth (REST + WS) | verified + documented | live; websocket-v1 page |
| 7 | History limits: trades ≤1000, fundings ≤1000, orders/history ≤500, positions/history ≤500 per page; `endTime` paging; history back to first trade | documented + verified | perps/spot REST pages; live account 220959 |
| 8 | REST budget 1200 weight/min/IP; history weight 20 + n/20; edge header `x-ratelimit-limit: 6000`; Cloudflare 1015 on bursts | documented + verified | api-rate-limits page; live headers; observed 1015 |
| 9 | WS limits/IP: 10 conns, 30 new/min, 1000 subs, 10 unique users, 2000 msg/min; 14 users accepted in test | documented + verified | api-rate-limits page; live test |
| 10 | ValueChain EVM: 2.04 s blocks, ~1 tx/block, geth fork `value-geth/1.1.1` | verified | RPC `rpc.valuechain.xyz` |
| 11 | Only deposits/withdrawals/registrations are on EVM; releaseFund = type-0x10 zero-fee system tx from `0xdEad…` | verified | Blockscout txs of `0x0101…0101` (2,000 txs) |
| 12 | REST `blockHeight` (~239.5 M, ~75 ms blocks) is the CLOB appchain, not EVM (14.78 M) | verified | REST balances vs `eth_blockNumber` |
| 13 | clobscan API exposes every appchain tx with signed payload, per-block and per-account (cursor) | verified | `clobscan-mainnet.sodex.dev/api/v1/*`; sodex.com bundle |
| 14 | Explorer WS pushes all block headers but only seq-0 tx per block | verified | `wss://mainnet-ws-explorer.sodex.dev/websocket` 20 s sample |
| 15 | Appchain signatures recover to registered API keys (payload reconstruction works) | verified | recovered `sky-40/25/58` of account 23342 |
| 16 | ClobGateway = EIP-1967 proxy, impl `0xe9532f96…0597` unverified; ProxyAdmin + owner = Safe 1-of-2 | verified | Blockscout; `eth_call` `getThreshold`, `getOwners` |
| 17 | 44 dispatch selectors; `register`, `createSubAccount` owner-only | verified | bytecode scan + `eth_call` reverts `0x118cdaa7` |
| 18 | Any EOA **or contract** can deposit into a registered account's spot/perps via 4-arg `depositERC20` | verified | `eth_call` with state override |
| 19 | `SoDexTokenCallForPermit.execute` cmdTypes: WithdrawToken, CreateBridgeCallFor, DepositERC20WithPermit, VaultDepositWithPermit(2), VaultRedeemWithPermit; ECDSA only | verified | verified source on Blockscout `0x890B…7801` |
| 20 | Gateway verifies ECDSA (recover) — no ERC-1271 documented; contracts cannot trade | documented + inferred | authentication-and-signing page; #15, #19 |
| 21 | Permissions mask: set bit disables; permissioned key must disable TRADE or CANCEL | documented | schema `APIKeyPermissionEnum`; Go SDK `api_key_permission.go` |
| 22 | Opentrade's mask 3 therefore disables trade+cancel (bug) | inferred (high) | #21 vs Opentrade `signing/actions.ts:53-55`, `routes/wallet.ts:53`, NOTES.md:241 |
| 23 | Max 5 API keys/master (docs) but MM account has ~150 | documented + verified | api-keys-and-nonces page; `/user/0x48D9…AD96/api-keys` |
| 24 | Sub-accounts exist in API model; creation owner-only; practically none exist | verified + inferred | `/user/{addr}/subaccounts`; `createSubAccount` revert; #2 |
| 25 | Builder: ≥100 vUSDC both engines; caps perps 200 / spot 2000 (0.1 bp units); max 10 approvals; real-time credit | documented | builder-codes page, public API page |
| 26 | `AddAPIKeyWithBuilder` = one signature for key + builder approval; `builder` excludes `permissions` | documented | authentication-and-signing, public API |
| 27 | No builder-tagged orders in 862 live sampled txs | verified | clobscan block sample |
| 28 | Origin in Tokyo (TTFB 14 ms Tokyo vs 257 ms FRA, 693 ms IAD); all hosts behind Cloudflare | verified (region) / inferred (provider unknown) | Globalping; DNS; headers |
| 29 | Server push delay E−T median 47 ms perps, 17 ms spot | verified | WS trade sample (clock-offset corrected) |
| 30 | Perps fees 0.012 %/0.040 % base; min notional 10 USD perps, 5 USD spot; batch ≤100; 600 orders/min & 20/s per account | verified + documented | `/markets/symbols`; fees & rate-limit pages |
| 31 | Perps ~17.5 tx/block, ~46 GB/day raw JSON; ~0.8 M fills/day; ~90 % from one MM | verified (sample) | clobscan + WS samples |
| 32 | Referral: 10 % fee rebate + 25 % points after 1,000 USDC volume | documented | SoDEX support article 2026-01-01 |
| 33 | Relayer: allowlisted integration ids, 2/s-10/5min-50/h per IP, mainnet only | documented | valuechain-evm/relayer page |

---

## Open questions (and how to close them)

1. **ERC-1271 / contract signers at the gateway** — unknowable read-only. Close on **testnet** with the owner's
   explicit go: register a Safe as recipient of a test deposit and try to sign `AddAPIKey` via 1271. Better: ask SoDEX.
2. **Permission-mask semantics in practice** — read `permissions` of any key Opentrade minted
   (`GET /api/v1/user/{addr}/api-keys`), or ask SoDEX whether a TRADE+CANCEL-only key is planned.
3. **User sub-account creation** (roadmap/API?) and whether internal transfers will be enabled — ask SoDEX.
4. **Whether "max 5 API keys" applies to normal users** and whether it can be raised for an executor that needs one
   key per follower (it doesn't: each follower's own account holds its own key; 5 is per follower) — confirm.
5. **Enforcement of "10 unique users per IP"** on WS account channels (test at larger scale from the Tokyo box
   within limits) and clobscan/explorer rate limits (none published).
6. **Leaderboard PnL definition** (why top PnL rows have ~0 volume) — compare with our own reconstruction.
7. **Unresolved ClobGateway selectors** (15) — only matter if SoDEX publishes the implementation source.
8. **Cloud provider of the Tokyo origin** — not determinable behind Cloudflare; only same-region placement matters.
9. **Revocation path** — docs say `DELETE /{engine}/accounts/api-keys`; Opentrade uses `POST …/revoke`; test on
   testnet.

## Recommendations for ValueDesk

1. **Architecture of the "copy contract":** make it a *policy + registry + fee* contract on ValueChain (leader
   registry, follower subscriptions with risk params, optional fee escrow/splits for leaders), not an execution
   venue. Execution = off-chain executor in **Tokyo** holding per-follower ordinary API keys registered with
   `AddAPIKeyWithBuilder` (one signature: key + our builder fee), short `expiresAt`, revocable by the user at any time.
   Publish every copy decision (leader tx hash → follower tx hash) for verifiability — the clobscan API makes both
   sides publicly auditable.
2. **Do not reuse Opentrade's permissioned-key code as-is**; fix the mask semantics first (and tell the owner —
   Opentrade's own safety claim is currently inverted).
3. **Data plane:** (a) record the gateway WS `trade` stream for all symbols (the only source of `bi/si`) — cheap,
   ~0.8 M rows/day; (b) resolve ids in bulk via `sodex.dev …/chain/users/addresses` and cache forever
   (ids are immutable); (c) backfill per-trader history lazily via REST (`positions/history` for realized PnL,
   `trades`, `fundings`) under the 1200-weight budget, spreading across IPs/time; (d) use clobscan
   `block/transactions` only for tracked leaders' order intent, and drop MM accounts (23342, 1001, 1002, 2140…) at
   ingest; (e) subscribe `accountOrderUpdate`/`accountTrade` per *actively copied* leader (≤10 per IP by the docs).
4. **Latency:** run the executor next to the Tokyo origin; measure from the existing live Tokyo box first (per the
   AWS hard rule — no new instances without an IaC plan and explicit go). Trigger on leader order acceptance
   (`accountOrderUpdate`) rather than fills where appropriate; send IOC orders with a price cap; batch followers
   (≤100 orders per request, but each follower is a separate account and key → one request per follower; stay under
   20 orders/s per account).
5. **Monetisation:** builder fee on perps (≤ 0.2 %; e.g. 0.05 % = `fee: 50` is competitive with Hyperliquid copy
   products), plus the referral programme (10 % of referred fees) for onboarding. Keep ≥100 vUSDC in both engines on
   the builder account. Reconcile income from `builderFee` on fills, not from balance deltas.
6. **Sizing & risk rules:** enforce min follower allocation so copied orders clear the 10 USD minimum; handle
   one-way netting when a follower copies several leaders on the same symbol; respect leader price bands; never
   deposit into an account whose owner is a contract.
7. **Ask SoDEX (partnership list):** trade-only keys, per-key symbol/notional caps, user sub-accounts + internal
   transfers, relayer allowlisting for our contract, higher WS per-IP user limits, and published implementation source
   of ClobGateway (upgradeable by a 1-of-2 Safe — disclose this risk to users).

## Relevant SoDEX developer documentation (all `https://sodex.com/documentation/…`, append `.md` for markdown)

- Index: `llms.txt`
- Trading: `for-developers/developers/trading` · `…/trading/quickstart` · `…/trading/api-keys-and-nonces` ·
  `…/trading/authentication-and-signing` · `…/trading/authentication-and-signing/manual-rest-signing` ·
  `…/trading/spot-trading` · `…/trading/perp-trading` · `…/trading/builder-codes-in-trading` ·
  `…/trading/api-rate-limits`
- API reference: `for-developers/api-reference/trading-api` · `…/trading-api/rest-v1/sodex-rest-public-api` ·
  `…/rest-v1/sodex-rest-spot-api` · `…/rest-v1/sodex-rest-perps-api` · `…/rest-v1/schema` ·
  `…/trading-api/websocket-v1` (+ `market-trade`, `account-updates`, `account-order-updates`, `account-trades`,
  `account-events`, `account-frontend-state`, `l2book`, `l4book`)
- ValueChain EVM: `for-developers/developers/valuechain-evm` · `…/contracts` · `…/relayer` · `…/transaction-finality` ·
  `…/gas-and-fees` · `…/differences-from-ethereum` · `for-developers/api-reference/json-rpc` ·
  `for-developers/api-reference/relayer-api`
- Mirror/funding: `for-developers/developers/mirror-protocol` · `…/lifecycle/valuechain-transfers` ·
  `…/lifecycle/withdrawals` · `for-developers/api-reference/mirror-api/asset-configuration` ·
  `…/mirror-api/sponsored-withdrawal`
- Wealth (vaults, referral bytes32): `for-developers/developers/wealth` · `…/wealth/contracts` · `…/wealth/referrals`
- Fees & mechanics: `trading-mechanics/trading-fees` · `trading-mechanics/orders-types` · `trading-mechanics/margin-tiers`
  · `trading-mechanics/funding`
- Architecture: `about-valuechain/how-valuechain-works` · `…/about-d2app` · `about-sodex/how-sodex-works`
- SDKs: `for-developers/sdks` · `…/python-sdk-guide` · `…/go-sdk-signing-guide`; GitHub
  `sodex-tech/sodex-go-sdk-public`, `sodex-tech/sodex-python-sdk-public`
- Undocumented but live: `https://clobscan-mainnet.sodex.dev/api/v1/…`, `wss://mainnet-ws-explorer.sodex.dev/websocket`,
  `https://mainnet-data.sodex.dev/api/v1/{leaderboard,perps/pnl/*,dashboard/*}`, `https://sodex.dev/mainnet/chain/*`,
  `https://alpha-biz.sodex.dev/biz/*`, referral article
  `https://sodex-support.zendesk.com/hc/en-us/articles/14761887936399`
