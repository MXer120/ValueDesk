# 07 — Gap fill: SoDEX contract-owned accounts, key permissions, rate limits, fund movement, firehose

Research date: 2026-09-25, 11:30–13:15 UTC, from a machine in Germany whose egress IP was shared with other
research agents running at the same time. Everything was read-only: public GET requests, public WebSocket
subscriptions, `eth_call` / `eth_simulateV1` with state overrides, `eth_getLogs`, Blockscout reads, public docs and
GitHub sources, and one Globalping HTTP measurement. No transaction was sent, nothing was signed, no key was
registered, nothing was deployed on mainnet or testnet, and no cloud resource was created. Nothing in the Opentrade
directory was modified.

This report resolves gaps **G1, G2, G4, G5 and G7** from the critic's list, plus the contradictions that touch
them. It supersedes the matching claims in reports 01, 03, 04, 05 and 06.

Confidence labels: **verified** = observed live or in code today; **documented** = official SoDEX docs or SDK;
**inferred** = reasoned from verified facts; **assumption** = not checked.

---

## TL;DR

1. **G1 is resolved, and the answer is yes: a contract can own a usable SoDEX account.** It can register
   permissionlessly, add and revoke API keys on-chain through `msg.sender`, and trade through those keys. SoDEX's
   own dominant market makers already work this way:
   - Accounts 1000, 1001, 1002, 2140, 4258, 23342, 199513 and 199514 are each owned by a `CustodyWallet` contract.
     These contracts belong to the **"SoDex LP Vault: vsMAG7.ssi"** (`0x3687…0876`).
   - SSIRFQ, a verified SoSoValue contract, owns account 222807 and registers makers as API keys on-chain.
   - Four Safes own accounts too; three of them added keys on-chain.
   - Every sampled order from these accounts was signed by a key that was added on-chain: 15/15 for account 23342,
     10/10 for 222807 and 6/6 for the EOA account 224678.
   - A state-override simulation run today registered a brand-new contract by depositing 1.1 native SOSO to it. The
     same contract then added and revoked a key.

   **The "copy contract = registry/policy/fee layer only" verdict in reports 01 and 03 is wrong.** A vault or a
   per-follower contract can own the trading account and keep an on-chain kill switch.
2. The contract path has limits:
   - Keys added on-chain carry **no permission mask and never expire**. They are ordinary full-permission keys.
   - No on-chain **builder-fee approval** exists (none is known). `ApproveBuilderFee` needs an ECDSA master
     signature, and SoDEX supports no ERC-1271. So an account owned by a contract probably **cannot pay ValueDesk a
     builder fee**. A vault would charge its fees on ValueChain instead.
   - For a contract owner the leaked-key blast radius is smaller than for an EOA. EVM withdrawals are paid only to
     the owner, here the contract (verified in `releaseFund`), and INTERNAL transfers are documented as unsupported.
3. **G2 is only partly resolved.** A scan of 3,786 top-leaderboard wallets found 5,655 non-default keys. Exactly
   **one** carries a `permissions` field: **mask 14** (`airdrop-corp-bot-01` on account 2056, registered
   2026-08-16 via `addPermissionedAPIKey`).
   - That key has signed **0 of 475** transactions since, so enforcement was never observed.
   - Registration alone cannot tell the two bit polarities apart: mask 14 is legal under both readings.
   - All three SoDEX artefacts say a set bit **disables** a permission: the schema, the Go SDK and the Python SDK.
     Under that reading, **mask 14 is a documented trade-only key** (TRADE also covers cancel). So "no trade-only key
     exists" (reports 01 and 03) is wrong on the docs.
   - **Mask 3 is wrong for an executor** (reports 04 §10.6 and 06): per the docs it disables trading and leaves
     withdraw and transfer enabled.
   - Keys registered with a builder via `AddAPIKeyWithBuilder` (for example SafePal's `safepal-*` keys, builder
     223169) are listed **without** a mask, so they are full-permission keys.
4. **G4:** the `x-ratelimit-*` header is a **6,000-weight-per-minute budget**. Per-route costs measured today:
   mark-prices 2, `perps/accounts/{a}/api-keys` 5, `state` 5, `user/{a}/api-keys` 20, `builders` 20, `ratelimit`
   20, account `trades` 20. OPTIONS preflights and 404s cost 0.
   - I held **1,375 weight/min** from my own process for 3 minutes. The IP total was ≥1,469–1,605/min, and then up
     to ≥1,977/min over the next 24 minutes. That produced **0 × 429**: the documented 1,200/min is **not** enforced
     as a hard cap on that route.
   - Separately, a **Cloudflare 1015 rule protects the history routes** (`/accounts/{a}/trades`,
     `/orders/history`). It blocked me at the 4th request in about 8 s, with 5,916 weight still left in the budget,
     for 60 s.
   - Signed POST limits cannot be measured read-only.
5. **G5:** an ordinary key **cannot send funds to a third party through any documented route**:
   - The EVM destination is fixed on-chain. `releaseFund(userId, token, amount)` pays `owner(userId)` (4/4 samples
     verified, including 1,000,000 vUSDC paid to a CustodyWallet).
   - Cross-engine moves use the magic `toAccountID = 999`.
   - INTERNAL (type 4) is documented as "not supported yet" on both engines.

   What remains is theft by adversarial trading, plus INTERNAL if it is ever enabled or not enforced. INTERNAL
   cannot be observed read-only, because clobscan does not index `transferAsset` and there is no public
   transfer-history endpoint.
6. **G7:** in a 90-minute capture of the whole venue (every symbol on both engines), the public `trade` firehose
   was **gap-free**: the per-symbol `t` sequences had no holes.
   - **58,965 of 58,967** fills seen on `accountTrade` for 5 watched accounts also appeared on the firehose. The 2
     misses sit at the window edges.
   - **222/222 and 149/149** of the REST fills of two active traders appeared on it too.
   - The firehose arrives **about 5 ms later at the median** than `accountTrade`, and 39 ms later at p90.
   - For resting orders, `accountOrderUpdate NEW` precedes the fill print by 420 ms at the median and 4.0 s at
     p90.
   - Liquidations are **takeovers**. They are recorded as zero-fee fills with `clOrdID "liquidation:<orderID>"` that
     use up a `t` in the symbol's sequence. None occurred in the window, so whether they appear on the firehose is
     still open. The same gap detector would expose them.
7. **One agreed market-maker filter:** use the accounts owned by the SLP-vault CustodyWallet contracts, found
   on-chain: `{1000, 1001, 1002, 2140, 4258, 23342, 199513, 199514}`.
   - They are on **99.6 %** of all prints in the capture.
   - **80.1 %** of prints have MM accounts on **both** sides, i.e. vault-to-vault trades.
   - Dashboard volume is therefore dominated by the venue's own LP vault, which supports report 06's suspicion
     about its revenue scenarios.
8. **The origin is in Japan.** Uncached TTFB on a per-account route was **25 ms from Osaka and 28 ms from Tokyo**.
   Other vantage points: Hong Kong 65 ms, Seoul 65 ms, Singapore 91 ms, Taipei 187 ms, Ashburn 702 ms,
   Frankfurt 994 ms.

---

## G1 — Can a contract (or a 7702 account) own a SoDEX account and delegate trading on-chain?

### Answer

**Yes. This is verified in production and in simulation.** A contract can do each of the following:

- **Register** permissionlessly. Anyone calls `ClobGateway.depositERC20(address(0), amount > 1 SOSO, recipient)`
  (`0x1828686a`, payable, native SOSO) with the contract as recipient. A Mirror deposit to the contract address also
  works.
- **Add an API key** on-chain: `addAPIKey(uint256 destination, string name, bytes pubkey)` (`0x8b53c6b9`, 0 = spot,
  1 = perps), called by the owning contract.
- **Revoke** it on-chain: `revokeAPIKey(uint256 destination, string name)` (`0x54ed5933`).
- **Trade** through that key. The engine accepts orders signed by keys added on-chain.
- **Receive withdrawals.** `releaseFund` pays the account owner, i.e. the contract.

This is the SoDEX equivalent of Hyperliquid's CoreWriter action 9 (add API wallet).

### Evidence

**1. Named interface (verified source on Blockscout).** Two verified contracts deployed on ValueChain mainnet ship
the ClobGateway interface:
- the "Sodex" strategy implementation `0xCA791cBaCC8e9ab39F60efbAb1C57AFdb949b7AF`, file `lib/sodex/IClobGateWay.sol`;
- SSIRFQ `0xeBBc6c0c08337ACbe42E1aA58d21354ec45D713f`, file `src/interfaces/IClobGateway.sol`.

The interface they ship:

```solidity
function depositERC20(address token, uint256 amount) external payable;
function depositERC20(address token, uint256 amount, address recipient) external payable;
function addAPIKey(uint256 destination, string memory name, bytes memory pubkey) external;
function revokeAPIKey(uint256 destination, string memory name) external;
```

SSIRFQ's NatSpec says it "deposits escrowed taker legs into its OWN spot account on the CLOB (the depositor is
`msg.sender`), and registers each maker's address as an API-key pubkey so the maker can operate that spot account".
`SSIRFQ.addMaker(maker)` calls `clobGateway.addAPIKey(SPOT, _apiKeyName(maker), abi.encodePacked(maker))`.
`removeMaker` revokes the key in lockstep.

**2. Events (decoded from logs).**

| Event | topic0 | Layout | Count (genesis → block 14,787,007) |
|---|---|---|---|
| key added | `0x4cdd93da746d9b8e9a81378729cfa3c5bd2af374b581462ed6e89578d52fac2c` | `(uint256 indexed userId, uint256 engine, uint256 accountId, string name, uint8 keyType, bytes publicKey)`. **No permissions field, no expiry field.** | **1,463**, blocks 306,715 → 13,778,416 (last: 2026-09-01 ~10:00 UTC) |
| `RevokeAPIKey(uint256,uint256,uint256,string)` | `0xca072ea87fd60a0f6e6f7056ff425d4f3c600ad308f958506c0ac7b71bee1bf6` | `(userId indexed, engine, accountId, name)` | **2** (account 1016, test keys, block ≈307k) |
| registration | `0x3b63e732…baba` | `(address indexed owner, uint256 userId, uint256 accountId)` | one per account |

**3. Who called `addAPIKey` (all 1,463 events joined to their transactions).**

| Path | Selector at `tx.to` | Events | Accounts |
|---|---|---|---|
| EOA owner calls ClobGateway directly | `0x8b53c6b9` | 675 | 291 distinct EOAs; `tx.from == owner(accountId)` in **675/675**. 638 events are one bot cluster naming keys `vol-###` (ids ≈223,6xx–224,8xx) |
| Vault manager → Sodex strategy `addClobAPIKey` → `CustodyWallet.call(gateway, addAPIKey)` | `0xdc617fab` | 763 | 1000, 1001, 1002, 2140, 23342, 199513, 199514 (keys `sky-*`, `arb-*`, `mm-*`) |
| Safe `execTransaction` → gateway `addAPIKey` | `0x6a761202` | 24 | 3142, 3222, 19704 (key name `webkey`) |
| SSIRFQ `addMaker` | `0xd4ec1fc2` | 1 | 222807 |

**4. Accounts owned by contracts: a full on-chain census.** A state-override scanner (a helper contract that exists
only inside `eth_call`) walked all account ids 1–230,800. It resolved each owner through ClobGateway
`0x792713b8(accountId)` and read `EXTCODESIZE` plus the first 32 bytes of code. **13 of 230,773 accounts have a
contract owner. None has an EIP-7702 designator (`0xef0100…`).**

| Account(s) | Owner code | What it is |
|---|---|---|
| 1000, 1001, 1002, 2140, 4258, 23342, 199513, 199514 | 1,052 bytes: `CustodyWallet` (OZ `Ownable`; `call(address,bytes)` `0x1b8b921d`, `withdraw(address)`) | Owned by 8 "Sodex" strategy proxies (`0xca10…`, `0x4d2f…`, `0x6c2c…`, `0xe6e9…`, `0x08c9…`, `0xfbe3…`, `0x7be2…`, `0x67d8…`). All share `vault()` = **`0x368788efa75ee0bc3ce8b4d1a920197af2e30876`, "SoDex LP Vault: vsMAG7.ssi" (vsMAG7.SLP)** |
| 3142, 3222, 19704, 19777 | 171 bytes: Safe proxy | Safe multisigs. 3142 and 3222 were registered by Mirror deposits (`SoDexTokenCustody.deposit` `0xe38398e2`, operator txs) on 2026-01-11 and 2026-01-12. 19704 and 19777 were not traced |
| 222807 | 130 bytes: ERC1967Proxy → `SSIRFQ` | SoSoValue's RFQ engine, registered 2026-07-09 by EOA `0x7c56…` via `depositERC20(0x0, 1.1 SOSO, SSIRFQ)` |

**5. The engine honours keys added on-chain.** I recovered the EIP-712 signer of each clobscan transaction by
rebuilding the Go-field-order payload hash and the `ExchangeAction` digest, then matched it against the on-chain
key-added events.

| Account | Owner type | Sampled successful txs | Signed by a key added on-chain |
|---|---|---|---|
| 23342 | CustodyWallet contract | 15 perps | **15/15** (sky-19, -21, -25, -28, -34, -48, -90, arb-03) |
| 222807 | SSIRFQ contract | 10 spot | **10/10** (maker key `0xAdb963F8…`, added by `addMaker`) |
| 224678 | EOA `0x4734…d3d3` | 6 perps | **6/6** (`vol-256` = `0xecE33695…`, added by a direct owner call on 2026-09-01) |

The gateway lists `vol-256` on both engines as `{"name":"vol-256","type":"EVM","publicKey":"0xece3…1d7a",
"expiresAt":0}`, with no `permissions` field. Keys added on-chain are therefore ordinary full-permission keys that
never expire.

**6. Simulation today, at the latest block, with state overrides.** Nothing was broadcast.

The setup:
- A forwarder contract `X` at a fresh address. Its code is overridden to forward calldata to ClobGateway.
- An orchestrator `D` with a 1,000 SOSO balance override.

Results:

| Step | Result |
|---|---|
| `X.addAPIKey(0,…)` before registration | revert `0x40298ab1` (caller not registered) |
| `D → depositERC20(address(0), 1.1e18, X)` with `value` 1.1 SOSO | success. The event trace (`eth_simulateV1`): WSOSO deposit 1.1 → 1.0 SOSO transfer (activation fee) → `CreateSubAccount` → **registration `owner=X, userId=accountId=230775`** → `Deposit` 0.1 SOSO |
| `getUserId(X)`, `getAccountsByAddress(X)` | 230775, `[230775]` |
| `X.addAPIKey(0,"vs-sim",pk)` and `X.addAPIKey(1,…)` | success; key-added event emitted with userId 230775 |
| `X.revokeAPIKey(1,"vs-sim")` | success; `RevokeAPIKey` event |
| `X.addAPIKey(2,…)` | revert `0xccee40f9` (invalid destination) |
| Deposits of 1.0 / 0.5 / 0.01 SOSO to an unregistered contract | revert **`0xe7178dd4`**, i.e. the amount does not exceed the 1 SOSO activation fee. `getMinDepositAmount(address(0))` = 0 |

**Correction to report 01:** `0xe7178dd4` is not "unregistered recipient". It is "deposit too small to activate".
A deposit of more than 1 SOSO to any address, contract or EOA, creates the account.

**7. Funds return to the contract.** `releaseFund(uint256 userId, address token, uint256 amount)` (`0x3e04f75c`,
a type-0x10 system transaction from `0xdEad…0000`) transfers `token` from the gateway to `owner(userId)`. The
recipient is not a parameter. Verified in 4/4 samples, including account 1001, whose CustodyWallet
`0xc50e…7f7b` received **1,000,000 vUSDC** in one `releaseFund`. The `Sodex` strategy then pulls tokens out of
the CustodyWallet (`CustodyWallet.withdraw(token)`, `onlyOwner`).

### What a contract-owned account does not get (inferred, or unknown)

- **No permission mask on-chain.** The on-chain `addAPIKey` has no `permissions` or `expiresAt` argument, and the
  event carries none. The executor key is therefore full-permission and never expires. For a contract owner that
  matters less: WITHDRAW pays the contract, and TRANSFER/INTERNAL is documented as unsupported (see G5).
- **No builder-fee approval is known.** Approval is `ApproveBuilderFeeAction`, a universal-domain EIP-712
  signature by the master key. The published interface has no on-chain equivalent, and ERC-1271 is not supported
  (report 01 §4).
  - Unless SoDEX adds one, **orders from contract-owned accounts cannot carry ValueDesk's builder code**. Orders
    with an unapproved builder are rejected (documented).
  - Monetisation for vault-style products must therefore be on-chain: management or performance fees in the vault
    contract. 14 ClobGateway selectors remain unresolved. An on-chain builder approval is not among the ones that
    have names.
- **On-chain success is not the same as engine acceptance.** The EVM contract does not revert on a duplicate add
  (same name twice) or a double revoke; it only emits events. The engine applies its own validation off-chain
  (name rules, per-account limits). **Propagation latency** from the EVM event to the engine accepting the key was
  not measured. EVM blocks take about 2 s, so an on-chain revoke takes at least 1 EVM block plus the engine's ingest
  time. It is a kill switch in seconds, not milliseconds. The observed first uses were hours or days after the add,
  which says nothing about latency.
- **Upgrade risk.** ClobGateway is an upgradeable proxy whose admin and owner is a **1-of-2 Safe** (report 01). The
  path could change without notice. It is undocumented in the public trading docs. Only the verified SoSoValue
  sources and live usage show it.
- **EIP-7702:** 0 of 230,773 owners are delegated today. A 7702-delegated EOA stays an EOA to the gateway, so it can
  still sign REST master actions, including `ApproveBuilderFee` and `addPermissionedAPIKey(14)`. Its delegated code
  can also call `addAPIKey`/`revokeAPIKey` on-chain with `msg.sender = EOA`.
  - That gives a hybrid: the follower's delegated code can let a ValueDesk "guardian" contract revoke the executor
    key on-chain when policy is violated, while the follower keeps the builder approval.
  - This works in principle, but it has not been exercised by anyone on ValueChain yet.

### Confidence

- verified: contracts own accounts, add keys on-chain and trade through those keys; permissionless registration via
  a native deposit (production precedent plus a simulation today); withdrawals pay the owner.
- documented: 0 = spot, 1 = perps (SSIRFQ NatSpec).
- inferred: no on-chain builder approval; no mask on on-chain keys; propagation latency of seconds.

### What would close the remainder

1. A testnet run of the whole vault loop, which needs the owner's explicit go:
   - deploy a minimal owner contract;
   - `depositERC20{value: 1.1 SOSO}` to itself;
   - `addAPIKey(1, name, executorPubkey)`;
   - measure the time until the first order signed by that key is accepted;
   - `revokeAPIKey`, then measure the time until orders are rejected.
2. Ask SoDEX:
   - (a) whether contract-owned accounts and the on-chain key path are supported long-term;
   - (b) whether an on-chain `approveBuilderFee` exists, or will exist, for contract accounts;
   - (c) whether a `permissions` argument can be added to the on-chain `addAPIKey`.

---

## G2 — Does a set permission bit disable or enable? Is there a trade-only key?

### Answer

**Documented: a set bit disables, and mask 14 is a trade-only key.** No enforcement has been observed on mainnet.
The one live permissioned key has never been used. **The polarity is still not proven empirically**, but every
published artefact agrees on it.

### Evidence

- **Docs.** REST schema `APIKeyPermissionEnum`: "A bit value of `1` means the permission is disabled. If
  `permissions` is omitted, all permissions are enabled."
  - TRADE (1) covers "Place, replace, modify, **and cancel** orders; schedule cancels; update perps leverage,
    margin, and collateral".
  - CANCEL = 2, WITHDRAW = 4 ("to EVM or the other engine"), TRANSFER = 8 ("sub-account and internal").
  - `AddPermissionedAPIKeyRequest`: "`permissions` must disable `TRADE`, `CANCEL`, or both; enabling both is not
    supported"; `builder` is not supported in this request.
  - The auth docs' example uses `permissions: 2`.
  - Sources: sodex.com `…/rest-v1/schema.md`, `…/trading/authentication-and-signing.md`.
- **Go SDK.** `common/enums/api_key_permission.go`: "A set bit disables the corresponding permission". It arrived in
  commit `3868fee743` (2026-07-13), together with the permissioned-key action. `main` HEAD is `66b00c071d`
  (2026-07-21).
- **Python SDK.** At commit `732ac02c02` (2026-09-08), `sodex/common/enums.py`: `class APIKeyPermission(IntFlag):
  """Disabled-permission bits … A set bit disables the corresponding permission. Omitting the permission mask …
  leaves all permissions enabled."""`. The test `test_add_permissioned_api_key_uses_permissioned_action` sends
  `TRADE|CANCEL` (3) as a signing fixture. `approve_agent(..., permissions=None)` registers ordinary keys by default.
  The two SDKs agree.
- **Live scan (verified).** I read `GET /api/v1/perps/accounts/{a}/api-keys` (weight 5) for **3,786 wallets**: the
  union of the top 1,000 of all 8 leaderboard window/sort combinations.
  - Result: 5,655 non-default keys, of which 245 have `expiresAt: 0` and 2,959 are expired but still listed.
    **Exactly 1 key has a `permissions` field.**
  - The key: wallet `0x4e60c1eca929166d4110a1094355afd70f9faa91` (account 2056), `{"name":"airdrop-corp-bot-01",
    "publicKey":"0xcecab970ddba6086e48954494c6ed16f6024b45a","expiresAt":0,"permissions":14}`.
  - It was registered on 2026-08-16 17:50:42 UTC. The appchain transaction is `type:"addPermissionedAPIKey"`,
    payload `{accountID:2056, expiresAt:0, name, permissions:14, publicKey(base64), type:1}`,
    `signatureChainID: 1`, status 1 on both engines.
  - **Since then the account has recorded 475 transactions: 0 signed by this key.** Eight other keys signed 418
    perps `newOrder`, 9 spot `batchNewOrder`, 9 `cancelOrder`, 4 `batchCancelOrder`, 4 `updateMargin` and 3
    `updateLeverage`. The master wallet signed 28 key registrations.
- **Why this does not settle the polarity.** Mask 14 is legal under both readings:
  - Under "set bit disables" it disables CANCEL and leaves TRADE: a trade-only key.
  - Under "set bit enables" it disables TRADE: a cancel/withdraw/transfer key.

  The discriminating observations are:
  - (a) a mask-12 registration being rejected (set = disable) or accepted (set = enable);
  - (b) a mask-14 key successfully placing an order (proves set = disable);
  - (c) a mask-3 key successfully placing an order (proves set = enable).

  None of these exists on mainnet among the 3,786 wallets.
- **Weak circumstantial evidence.** A bot operator chose 14 and named the key `…-bot-01`, which fits the documented
  meaning "trade-only" (inferred).
- **Ordinary keys have no field.** On-chain keys (`vol-256`) and builder keys (SafePal `safepal-*`, registered
  through `addAPIKey` with `builder {id: 223169, fee: 500}`) come back with no `permissions` field. Per the schema
  they have every permission. This settles contradiction "03 fact 26 vs 04 §4.2": `permissions` appears **only**
  on permissioned keys.
- **Opentrade.** Its own working tree was corrected today (`Opentrade/docs/PERMISSION-MASK.md`, 2026-09-25):
  - the resting key is now mask 14;
  - minting on mainnet is refused until the testnet plan T1–T9 passes;
  - the old mask 3 is documented as "cannot trade; can withdraw and transfer".

  Opentrade never placed a real order, so nothing about its key model is "verified" (report 06's wording).

### Consequences for the executor key model

| Onboarding option | Signatures | Key can trade | Key can WITHDRAW/TRANSFER | Builder fee |
|---|---|---|---|---|
| `AddAPIKeyWithBuilder` (one signature) | 1 | yes | **yes** (no mask; documented + verified SafePal case) | yes |
| `addPermissionedAPIKey(mask 14)` + `ApproveBuilderFee` | 2 | yes per docs (**unobserved**) | no per docs (**unobserved**) | yes |
| `addPermissionedAPIKey(mask 3)` (reports 04 §10.6, 06) | 1–2 | **no** per docs | **yes** per docs | — |
| Contract-owned account + on-chain `addAPIKey` (G1) | on-chain tx | yes (verified) | yes, but WITHDRAW pays the contract | **no known path** |

### How to close it

- **Cheapest (read-only, passive):** watch account 2056. The first transaction signed by `0xcecab970…` settles the
  question:
  - a successful `newOrder` means set = disable, and mask 14 trades;
  - a successful `cancelOrder` means TRADE covers cancel.

  Poll `clobscan …/perps/account/transactions?address=0x4e60…aa91` hourly and ecrecover each new transaction. This
  costs about 24 requests a day.
- **Decisive (needs the owner's go, testnet only):** Opentrade `docs/PERMISSION-MASK.md` steps:
  - T1: mask 12 must be rejected;
  - T3a: a mask-14 order must be accepted;
  - T3b: a mask-14 cancel must be accepted;
  - T3c: a mask-14 transfer or withdrawal must be rejected.
- **Ask SoDEX** to confirm that mask 14 is a supported "trade-only" key, and whether a mask can be combined with a
  builder approval in one signature.

---

## G4 — Binding per-IP REST budget

### Answer

- The header budget is **6,000 weight per minute per IP**. It resets on the minute boundary
  (`x-ratelimit-reset` = epoch seconds of the next minute).
- The documented **1,200 weight/min was not enforced** at about 1.4–2.0k weight/min on a weight-5 account route.
- **A stricter Cloudflare rule (1015) guards history routes** at a few requests per 10 s. It is independent of the
  weight budget.
- Whether signed order POSTs draw from the same budget is **unknown read-only**.

### Evidence (verified today; egress IP shared with other agents, so "others" is background load)

- **Per-route weights.** Each is `remaining` before minus after, bracketed by weight-2 calls, 3 repetitions, with
  noisy samples discarded:

  | Route | Weight |
  |---|---|
  | `/perps/markets/mark-prices` | 2 |
  | `/perps/markets/symbols` | 1 |
  | `/perps/accounts/{a}/api-keys` | 5 |
  | `/perps/accounts/{a}/state` | 5 |
  | `/user/{a}/api-keys` | 20 |
  | `/user/{a}/builders` | 20 |
  | `/user/{a}/ratelimit` | 20 |
  | `/perps/accounts/{a}/trades?limit=10` | 20 |
  | 404 route | 0 (no rate-limit headers on the response) |
  | `OPTIONS /perps/trade/orders` preflight (204) | 0 (no headers) |

- **Load test** (`keyscan.mjs`: 3,786 GETs of the weight-5 api-keys route):

  | Minute (UTC) | My weight | IP total ≥ (6000 − min remaining) | Others ≥ | 429s |
  |---|---|---|---|---|
  | 12:10 | 1,375 | 1,605 | 230 | 0 |
  | 12:11 | 1,375 | 1,469 | 94 | 0 |
  | 12:12 | 1,080 | 1,504 | 424 | 0 |
  | 12:13–12:34 (22 min) | ≈585–590/min | 702–1,977 per minute | up to 1,392 | 0 |

  In total: 3,786 requests, 0 non-200 responses, and the minimum remaining in any minute was 4,023. **The 1,200
  documented limit is not a hard per-IP cap. The 6,000 budget was never exhausted.**
- **Cloudflare 1015.** Earlier the same session, `/perps/accounts/{a}/trades`, `/spot/accounts/{a}/trades` and
  `/perps/accounts/{a}/orders/history` returned `HTTP 429`, `text/plain`, body `error code: 1015` and
  `Retry-After: 15–60`. At the same moment `positions/history`, `fundings`, `state`, `api-keys` and mark-prices
  returned 200.
  - A clean probe of `/perps/accounts/{a}/trades?limit=1` every ~2.5 s gave 200, 200, 200, then **429 at the 4th
    call (t = 8 s, `Retry-After: 60`)** while `x-ratelimit-remaining` was **5,916**.
  - 1015 responses carry no `x-ratelimit-*` headers and do not decrement the budget.
  - Other agents may have been calling the same route class from this IP, so the exact threshold is unknown. It is
    on the order of a few requests per 10 s per IP for fill/order history.
- **Signed POSTs.** Not measured: no signed requests were allowed. The documented numbers:
  - order-batch weight `1 + floor(N/40)`;
  - per-account limits of **600 orders/min and 20 orders/s**;
  - an address action quota of `cumulativeVolume + 10,000`.

  Report 03's "one egress IP ≈ 1,200 follower orders/min" is therefore unsupported. The per-IP GET budget is 6,000,
  POSTs probably draw from it at weight 1 or more, and the per-account caps apply per follower. The real ceiling for
  a fan-out executor is unknown.

### How to close it

- From the future executor box, with the owner's go: a testnet burst of signed orders from N follower accounts,
  watching headers and 429s.
- Ask SoDEX for the builder or partner tier and the Cloudflare rule for POST routes.
- For backfills, pace the history routes at ≤ 1 request per 5 s per IP, or use clobscan plus the firehose instead.

---

## G5 — Can a leaked ordinary key move funds to a third party?

### Answer

**Not through any documented or observable route.** EVM withdrawal destinations are fixed on-chain to the account
owner. Cross-engine moves go to the same owner. INTERNAL (type 4) is documented as "not supported yet" on both
engines. Whether INTERNAL is actually **enforced** cannot be observed read-only. The residual theft vector is
adversarial trading, e.g. filling an attacker's resting orders at off-market prices within the price bands.

### Evidence

- **On-chain EVM withdrawal (verified).** `releaseFund(uint256 userId, address token, uint256 amount)` is called by
  sequencer `0xdEad…0000`. It emits `Withdraw(uint256 indexed userId, address indexed token, uint256 amount)` and
  transfers to `owner(userId)`. Four decoded samples:

  | userId | Recipient = owner | Amount |
  |---|---|---|
  | 221780 | `0xbeac…07c6` | 1 vUSDC |
  | 998 (Mirror) | `0x0151…5a23` | 20.06 vUSDC |
  | 1001 | CustodyWallet `0xc50e…7f7b` | 1,000,000 vUSDC |
  | 17139 | `0x267b…2566` | 20,000 vUSDC |

  No recipient parameter exists. 317 `Withdraw` events in the last 30,000 blocks (~17 h): 205 through Mirror
  account 998, the rest to owners.
- **Leaving ValueChain.** External bridging requires the EVM balance holder's own ECDSA `WithdrawToken` permit
  (`SoDexTokenCallForPermit.execute`, report 01 §4). An API key is a different key and cannot sign it (inferred from
  verified source).
- **Docs.**
  - Spot: "Transfer asset to EVM chain: `toAccountID=999, type=EVM_WITHDRAW`"; "to perps: `toAccountID=999,
    type=PERPS_WITHDRAW`"; "**Internal transfer between spot chains is not supported yet.**"
  - Perps: "to spot: `toAccountID=999, type=SPOT_WITHDRAW`"; "Transfer assets to the EVM chain is not supported
    yet."; "**Internal transfer between perps chains is not supported yet.**"
  - `TransferAssetRequest{id, fromAccountID, toAccountID, coinID, amount, type}` has no address.
  - The Python SDK's transfer helpers all use `TREASURY_ACCOUNT_ID = 999`, and there is no INTERNAL helper
    (`sodex/client/client.py`).
- **Not observable read-only.**
  - clobscan's `account/transactions` does **not** index `transferAsset`. Account 221780 had 34 EVM withdrawals
    between 2026-09-24 21:28 and 09-25 12:18 UTC, while its newest clobscan spot transaction is from 09-24 09:37.
  - The query parameter `action=` is ignored.
  - There is no public transfer-history route: 8 candidate paths all return 404.
  - So a successful INTERNAL transfer between two owners could not be detected in any public dataset I could reach.
- **Sub-accounts**, the other TRANSFER target, practically do not exist: creation is `onlyOwner` on ClobGateway, and
  user and account id sequences coincide (report 01).

### Consequence

- **An ordinary executor key is not custody in the withdrawal sense.** It cannot pay itself. It is custody in the
  trading sense: it can lose the follower's balance through deliberately bad trades.
  - A TEE (or equivalent: attested policy, per-order bounds, market allowlists) protects against that.
  - Mask 14 would additionally close WITHDRAW/TRANSFER, if the polarity is confirmed (G2).
- Report 06 option E, "could move all follower funds anywhere", is wrong for the documented protocol.
- Report 03, "can move follower funds", is right only for spot↔perps↔own-EVM moves.

### How to close it

- Testnet step T7 in Opentrade `PERMISSION-MASK.md`: an INTERNAL transfer of 1 vUSDC to a second owner-controlled
  account. It needs the owner's go.
- Or a written statement from SoDEX that type 4 is rejected at the gateway and at the engine.

---

## G7 — Is the public trade firehose complete and fast?

### Answer

- **Complete for ordinary fills, and as fast as the per-account stream.** Over 90 minutes it had no dropped prints,
  no sequence holes, and 100 % coverage of every fill that the per-account `accountTrade` stream reported.
- **Liquidation takeovers were not exercised.** None occurred in the window among the accounts I could check (see
  below). Their coverage stays open.

### Method (verified)

- Capture from 11:31:56 to 13:01:56 UTC, script `capture.mjs`. Four sockets from one IP:
  - `trade` on all 98 perps symbols;
  - `trade` on all 43 spot symbols;
  - on perps: `accountTrade` and `accountEvent` for 5 accounts, plus `accountOrderUpdate` for 3 of them;
  - on spot: `accountTrade` for 4 accounts.
- The 5 accounts:
  - 1002 and 2140, SLP-vault MMs;
  - 52599, rank 1 by 24H volume;
  - 230528, rank 2;
  - 17139, positive PnL.
- Every frame was logged with its local receive time. Only relative timings are used, so the ≈420 ms clock offset
  of this machine cancels out.

### Results

| Metric | Value |
|---|---|
| Unique prints | **57,634** (perps 48,459 on 91 symbols, spot 9,175 on 34 symbols) = 10.7 prints/s ≈ **0.92 M/day** |
| Per-symbol `t` continuity | `t` is a per-symbol sequential trade id. Span-expected 57,633, received 57,634 (duplicates removed): **0 holes on any symbol** |
| Reconnects | Firehose sockets: none. Spot account socket: one `1006` close at 11:54:08, reconnected after 2 s |
| Snapshot frames | none (`type` was always `update`) |
| `accountTrade` fills (5 accounts, both engines) | 58,967 unique fills (keyed on symbol, `t`, order `i`); **58,965 found in the firehose**. The 2 misses fall in the first or last seconds of the window |
| Local arrival, firehose minus `accountTrade`, same fill | p10 −24 ms, **p50 +5 ms**, p90 +39 ms, p99 +99 ms; the firehose was later in 58.8 % of cases |
| Server send time `E`, firehose minus `accountTrade` | p10 −25, p50 +4, p90 +36, p99 +97 ms. The difference is server-side, not network |
| Push delay `E − T` (block time → send) | firehose p50 53 / p90 101 / p99 403 ms; `accountTrade` p50 49 / p90 81 / p99 186 ms |
| `accountOrderUpdate` fill vs firehose print | p50 +3 ms (firehose later), p90 +38 ms |
| `accountOrderUpdate` NEW → firehose print of the same order | p10 −31 ms (immediately filled orders), **p50 +420 ms, p90 +3,963 ms** (n = 374 fills from resting orders) |
| `accountEvent` (liquidation) messages | 0 |
| Distinct account ids in prints | 631 |
| Prints with ≥1 SLP-vault MM side (`{1000,1001,1002,2140,4258,23342,199513,199514}`) | **99.6 %**; with **both** sides MM: **80.1 %**. 1002 is on 44,164 prints (76.6 %), 23342 on 33,314, 2140 on 21,481, 1001 on 4,605 |
| REST reconciliation (per-account `trades` vs firehose `bi`/`si`, inner window 11:32:56–13:00:54) | 52599: **222/222** REST fills present in the firehose. 230528: **149/149**. 17139: no fills in the window. 0 `liquidation:` fills. Requests paced at 20 s, no 1015 |

### Liquidations, ADL and takeovers

- SoDEX liquidation is a **takeover** by a liquidator account (documented):
  - `Position.isTakenOver`, `takeOverPrice`;
  - WS `accountEvent` `WsUserLiquidation{lid, aid, av, mm, B[], P[]}`, sent to both the liquidator and the
    liquidated user.
- **Verified on a historical case**, account 1699 (`0x8293…f578`), 2026-04-22 13:46:29 UTC. The takeover appears in
  the account's REST fills as `{"symbol":"BTC-USD","tradeID":5013908,"clOrdID":"liquidation:3558819116",
  "side":"BUY","price":"78678.35","quantity":"0.00564","fee":"0","isMaker":false}`.
  - It carries a **normal per-symbol `tradeID`**, and that id sequence is the same as WS `t`.
  - Therefore: if takeovers are published, they show up on the firehose as prints. If they are not published, they
    leave **holes in `t`**, which a gap detector sees.
- There were 0 holes in 90 minutes. Either no takeover happened venue-wide in the window, or takeovers are
  published.
- I scanned `positions/history?limit=10` for all 627 non-MM accounts that appeared in the window. It found **0
  takeovers** within or up to 10 minutes before the window. The scan ran at ≈1 request/s, about 1,200 weight/min,
  for 15 minutes with 0 non-200 responses, which is one more G4 data point.
- So this run did not test whether takeovers are published.
- One blind spot remains: an account liquidated in the window that had no other print would not appear in the
  scanned list. That case is exactly the one the `t`-hole detector covers.
- ADL is not mentioned anywhere in the SoDEX docs (grep of the schema and the perps and spot REST pages).
- **To close:** run the recorder with a per-symbol `t` gap alarm. On any hole, or on any `accountEvent`, pull
  `positions/history` (`isTakenOver`) and REST `trades` (`clOrdID` prefix `liquidation:`). The first takeover then
  settles whether it is published.

### What this means for ValueDesk

- **The firehose is a valid single source** for indexing every trader, and for copy triggers on fills. `accountTrade`
  is not meaningfully faster: median 5 ms. Both carry the same block-time (`T`) stamp.
- **Use `accountOrderUpdate` for actively copied leaders** who rest limit orders. It sees the order about 0.4 s
  (median) to 4 s (p90) before the fill print. It is capped at 10 unique users per IP (documented); 5 users on one
  connection worked fine here.
- **Redundancy is still required.**
  - Public REST trades carry no `bi`/`si` and return only the latest ≤500 prints per symbol, so a disconnect cannot
    be backfilled with attribution from REST.
  - Run 2 independent firehose sessions (different IPs or hosts) and dedupe on `(engine, symbol, t)`.
  - Fill any remaining holes from per-account REST for tracked leaders.
- **Filter the MM set at ingest** using on-chain ownership rather than a hand list. The 8 CustodyWallet-owned
  accounts account for 99.6 % of prints. 80 % of prints are SLP vault against SLP vault.

---

## Contradictions resolved

Only the contradictions that touch SoDEX contracts, keys, limits, fund movement, the firehose and latency are
resolved here. The Hyperliquid items (trade count, agent `vault_usd_transfer`), browser signing and builder-fee
stacking belong to other gap reports.

| Claim under dispute | Resolution | Confidence |
|---|---|---|
| **01 TL;DR 1 / verdict, 03 fact 37:** "a contract cannot own a usable SoDEX account; the copy contract is only registry/policy/fee" | **Wrong.** 13 accounts are contract-owned today, including the venue's main MMs, and they trade through keys added on-chain. A fresh contract can register with a deposit of more than 1 SOSO and add or revoke keys itself (G1) | verified |
| **01:** "no `addAPIKey`/register user txs anymore"; `0x8b53c6b9` unresolved. **03:** on-chain `addAPIKey` "unknown" | `0x8b53c6b9` = `addAPIKey(uint256 destination, string name, bytes pubkey)` and `0x54ed5933` = `revokeAPIKey(uint256,string)`, both named in verified SoSoValue sources. 1,463 key-added events in total: 675 direct EOA calls (last 2026-09-01), 763 via SLP-vault strategies, 24 via Safes, 1 via SSIRFQ | verified |
| **01 §4:** "unregistered recipient → `0xe7178dd4`" | `0xe7178dd4` is returned when the deposit is **≤ 1 SOSO** (the activation fee). 1.1 SOSO registers any address | verified (simulation) |
| **API-key mask:** 01/03 say no trade-only key exists; 04 §10.6 and 06 build on mask 3 | Docs, both SDKs and the schema all say a set bit disables. Hence **mask 3 = cannot trade, can withdraw and transfer**, and **mask 14 = trade-only** (TRADE covers cancel). Both sides were partly wrong. **Not observed live**: the only mask-14 key on mainnet (account 2056) is unused | documented; enforcement unverified |
| **06:** Opentrade's key model is "verified" | Not verified. Opentrade placed no real order, and it re-documented the mask today (`docs/PERMISSION-MASK.md`) | verified (code/docs) |
| **03 fact 26 vs 04 §4.2:** is there a `permissions` field? | It appears **only** on permissioned keys. 1 of 5,655 non-default keys in 3,786 wallets had it. Ordinary, on-chain and builder keys have none, which means all permissions | verified |
| **Blast radius:** 01 "cannot send to a third party" vs 03 "can move follower funds" vs 06 E "anywhere" | **01 is right for the documented protocol.** The EVM withdrawal recipient is fixed on-chain to the owner. Cross-engine goes to the same owner. INTERNAL is documented as unsupported. 03 is right only for moves among the owner's own balances. **06 E is wrong.** INTERNAL enforcement is unobservable read-only (G5) | verified (on-chain) + documented |
| **01 fact 23:** "max 5 keys is overridable (MM ~150)" | The MMs' keys are contract/on-chain keys (23342: 169 events; 1002: 366). But REST-registered **EOA** accounts also exceed 5 active non-default keys: `0x2085…8e85` has 9 and `0x16c9…3814` has 7. The documented 5-key cap is not enforced as written on either path. Some REST `addAPIKey` txs fail (status 0, empty `msg`), cause unknown | verified |
| **03 §D.2:** one IP ≈ 1,200 follower orders/min | The per-IP GET budget is **6,000 weight/min** (header), and 1,375–1,977/min sustained produced 0 × 429. Signed POST limits are unmeasured. The per-account limits (600/min, 20/s) apply per follower. History routes carry a separate Cloudflare 1015 rule (G4) | verified (GET) / unknown (POST) |
| **01 §8 / 03 §D.2:** copy latency 60–250 ms and 100–200 ms | Measured today: push delay `E−T` p50 53 ms, p90 101 ms (firehose) and p50 49 / p90 81 ms (`accountTrade`). Japan TTFB for an uncached route: 25–28 ms. The POST and acknowledgement path is **still unmeasured**. The estimate from Tokyo stays ≈ 100–200 ms, leader fill → follower inclusion | verified (components) / inferred (total) |
| **Origin:** 01 Tokyo, 03 unknown, 04 "far from Frankfurt", 05 "East Asia" | **Japan.** Globalping today on `/perps/accounts/{a}/state`, TTFB: Osaka 25 ms (KIX edge), Tokyo 28 ms (NRT), Hong Kong 65, Seoul 65, Singapore 91, Taipei 187, Ashburn 702, Frankfurt 994 ms | verified |
| **MM filter:** 01 names 23342 (~90 % of clobscan actions) and 1001; 05 names 1002 (85 % of prints); ingest list 23342/1001/1002/2140 | **One definition:** accounts whose owner is an SLP-vault CustodyWallet, found on-chain. That is `{1000, 1001, 1002, 2140, 4258, 23342, 199513, 199514}`. 01 and 05 measured different things (order actions vs prints) and are both consistent. Share of prints: 1002 76.6 %, 23342 57.8 %, 2140 37.3 %, 1001 8.0 %; the set covers 99.6 % of prints | verified |
| **Leaderboard crawl:** 01 and 04 say 2,693 pages give every id↔wallet pair; 05 says capped at 1,000 | **05 is right.** All 8 window/sort combinations stop at 1,000 rows (page 21 empty). The union is 3,786 unique wallets. For every id↔wallet pair, use `POST sodex.dev/mainnet/chain/users/addresses` (500 ids/call), or a state-override `eth_call` scanner over ClobGateway `0x792713b8` (all 230,800 ids in 77 calls, done today) | verified |
| **06:** "134,605 wallets in the 30D window" | `total` is not window-specific. It read 134,607 at 13:03 today for 30D, the same figure as other windows. It is the size of the ranked population, not a 30-day count | verified |
| **SoDEX registration rate:** 01 ≈ 50/day (EVM logs) vs dashboard 91–310/day; 05 saw +1 in 12 min | EVM registration events over the last 60,000 blocks (34.1 h): **270 new accounts (ids 230,508–230,777) ≈ 190/day**, which fits the dashboard. `getNextAccountId` rose from 230,773 (≈10:14) to 230,778 (13:03). The rate is bursty, and 01's 20k-block sample hit a quiet stretch | verified |
| **01:** "nobody uses builder codes" (0 of ~860 sampled txs) | The sample was MM-dominated. SafePal registers keys through `addAPIKey` **with** `builder {id: 223169, fee: 500}` (key names `safepal-<hex>`, `expiresAt` 2100-01-01). 22 of the 3,786 top wallets hold one. Builder 223169 = `0x6Dc3…8F0D`, the "registered non-owner EOA" the critic used | verified |
| **05:** data-API limits cited from `…/data-api/authentication-and-limits.md` | That page describes the SoSoValue Market Data API. `mainnet-data.sodex.dev` returns no rate-limit headers (checked today), and I crawled 160 leaderboard pages at ~1.5 req/s without an error. Its limits are unknown | verified (headers) / documented-3p mismatch |
| **06:** revenue scenarios use dashboard volume ($140M/day) | 80 % of prints have SLP-vault accounts on **both** sides and 99.6 % on at least one. Retail-addressable volume is a small fraction of the dashboard figure. Recompute revenue from non-MM prints only | verified (capture) / inferred (revenue impact) |

---

## Facts table

| # | Claim | Confidence | Source |
|---|---|---|---|
| 1 | ClobGateway exposes `addAPIKey(uint256 destination, string name, bytes pubkey)` `0x8b53c6b9` and `revokeAPIKey(uint256 destination, string name)` `0x54ed5933`; destination 0 = spot, 1 = perps; the caller is the account owner | verified (source) + documented (NatSpec) | Blockscout verified source: `0xCA791c…b7AF` `lib/sodex/IClobGateWay.sol`; `0xeBBc6c…713f` `src/interfaces/IClobGateway.sol` |
| 2 | The key-added event (topic0 `0x4cdd93da…fac2c`) has no permissions and no expiry. There are 1,463 such events; the last is at block 13,778,416 (2026-09-01) | verified | `eth_getLogs` on `0x0101…0101` |
| 3 | `RevokeAPIKey(uint256,uint256,uint256,string)` topic0 `0xca072ea8…1bf6` has fired only 2 times ever | verified | `eth_getLogs` |
| 4 | In 675/675 direct `addAPIKey` txs, `tx.from` = `owner(accountId)` (291 EOAs) | verified | tx join, ClobGateway `0x792713b8` |
| 5 | 13 of 230,773 accounts have contract owners: 8 SLP-vault CustodyWallets (1000, 1001, 1002, 2140, 4258, 23342, 199513, 199514), 4 Safes (3142, 3222, 19704, 19777), 1 SSIRFQ (222807). No owner has a 7702 designator | verified | state-override scanner over ids 1–230,800 |
| 6 | The 8 CustodyWallets belong to strategies of vault `0x3687…0876` "SoDex LP Vault: vsMAG7.ssi" | verified | `owner()` / `vault()` `eth_call`; Blockscout token name |
| 7 | Keys added on-chain sign accepted orders: 23342 15/15, 222807 10/10, 224678 6/6 | verified | clobscan `transaction?tx_hash=` + EIP-712 signer recovery |
| 8 | The gateway lists keys added on-chain as `expiresAt: 0` with no `permissions` field (full permission, never expire) | verified | `GET /api/v1/user/0x4734…d3d3/api-keys` |
| 9 | `depositERC20(address(0), >1 SOSO, recipient)` registers any recipient, including a contract. 1 SOSO is the activation fee; ≤1 SOSO reverts `0xe7178dd4` | verified | `eth_simulateV1` / `eth_call` with state overrides; SSIRFQ registration tx `0xd494…c057` (2026-07-09) |
| 10 | A freshly registered contract can `addAPIKey` on both engines and `revokeAPIKey` in the same simulation; destination 2 reverts `0xccee40f9`; unregistered reverts `0x40298ab1` | verified | `sim.mjs`, `sim2.mjs` |
| 11 | `releaseFund(userId, token, amount)` pays `owner(userId)`; the recipient is not a parameter | verified | 4 decoded withdrawals, incl. 1,000,000 vUSDC to CustodyWallet `0xc50e…7f7b` |
| 12 | No on-chain builder-fee approval is known; `ApproveBuilderFee` needs an ECDSA master signature | inferred | published interface; report 01 (no ERC-1271) |
| 13 | The permissions mask is documented as "set bit disables". Mask 14 = trade-only (TRADE covers cancel). Mask 3 = no trade, with withdraw and transfer | documented | REST schema; Go SDK `api_key_permission.go` (3868fee); Python SDK `enums.py` (732ac02) |
| 14 | Exactly 1 of 5,655 non-default keys in 3,786 top wallets has a mask: 14 (`airdrop-corp-bot-01`, account 2056, registered 2026-08-16). It has signed 0 of 475 txs since | verified | `GET /perps/accounts/{a}/api-keys` scan; clobscan + signer recovery |
| 15 | Builder-coded keys (SafePal, builder 223169, `fee: 500`) carry no mask, so full permission. 22 of the 3,786 wallets have one | verified | api-keys scan; clobscan `addAPIKey` payload |
| 16 | EOA accounts hold up to 9 active non-default REST-registered keys, so the documented 5-key cap is not enforced as written | verified | api-keys scan (`0x2085…8e85`: 9; `0x16c9…3814`: 7) |
| 17 | The `x-ratelimit-limit: 6000` budget is weight per IP per minute and resets on the minute | verified | header decrements per route |
| 18 | Weights: mark-prices 2, symbols 1, `perps/accounts/{a}/api-keys` 5, `state` 5, `user/{a}/api-keys` 20, `builders` 20, `ratelimit` 20, account `trades` 20. OPTIONS and 404 cost 0 | verified | `w.mjs` |
| 19 | 1,375 weight/min for 3 min from one process (IP total ≥1,469–1,605), then up to ≥1,977/min: 0 × 429 in 3,786 requests | verified | `ratelog.ndjson` |
| 20 | A Cloudflare 1015 rule on `/accounts/{a}/trades` and `/orders/history` blocked the 4th request in ~8 s (Retry-After 60) while 5,916 weight remained | verified (threshold confounded by the shared IP) | `cf.mjs` |
| 21 | TransferAsset has no address field. INTERNAL is documented "not supported yet" on spot and perps. The Python SDK uses only `toAccountID=999` | documented | schema; perps/spot REST pages; `sodex/client/client.py` |
| 22 | clobscan does not index `transferAsset`, and there is no public transfer-history route | verified | account 221780: 34 EVM withdrawals, none in clobscan; 8 candidate routes return 404 |
| 23 | The firehose had 0 `t` holes across 57,634 prints on 125 symbols in 90 min; 58,965/58,967 `accountTrade` fills and 371/371 REST fills of 2 traders are present | verified | `capture.mjs`, `g7.mjs`, `recon.mjs` |
| 24 | Firehose vs `accountTrade`, same fill: p50 +5 ms, p90 +39 ms. `E−T` p50 53/49 ms, p90 101/81 ms | verified | same |
| 25 | `accountOrderUpdate` NEW precedes the fill print of resting orders by p50 420 ms, p90 3.96 s | verified | same |
| 26 | Liquidations are takeovers, recorded as zero-fee fills `clOrdID "liquidation:<id>"` with a normal per-symbol `tradeID` | verified (historical REST) + documented | account 1699 REST trades; schema `Position.isTakenOver`, `WsUserLiquidation` |
| 27 | 99.6 % of prints involve an SLP-vault account and 80.1 % have one on both sides | verified | capture |
| 28 | The gateway origin is in Japan: uncached TTFB 25 ms from Osaka and 28 ms from Tokyo vs 994 ms from Frankfurt | verified | Globalping measurement `2nNKuwB10UE8MrPY200021CTz` |
| 29 | ~190 new accounts/day (270 in 34.1 h); `getNextAccountId` = 230,778 at 13:03 UTC | verified | registration logs; `eth_call 0xab00c0da` |
| 30 | Leaderboard pages stop at 1,000 rows for all 8 combinations; the union is 3,786 wallets; `total` 134,607 | verified | `mainnet-data.sodex.dev/api/v1/leaderboard` |

---

## Open questions

1. **Permission polarity in practice (G2).**
   - Passive way to close it: watch account 2056's mask-14 key for its first transaction. A successful `newOrder`
     settles it.
   - Active way (owner's go, testnet): Opentrade T1 / T3a–c.
2. **INTERNAL (type 4) enforcement (G5).**
   - Testnet T7 (owner's go), or a written statement from SoDEX.
   - Until then, treat a leaked ordinary key as able to lose funds by trading, not to transfer them.
3. **On-chain key propagation latency (G1).**
   - How long it takes from a `addAPIKey`/`revokeAPIKey` EVM block (~2 s blocks) until the engine accepts or
     rejects that key.
   - Testnet only, with the owner's go.
   - This decides how "hard" an on-chain kill switch is.
4. **On-chain builder approval for contract-owned accounts.** Is there one, or will there be? Ask SoDEX. Without it,
   vault products monetise through on-chain fees, not builder codes.
5. **Long-term support of contract-owned accounts and the on-chain key path.** It is used by SoDEX's own LP vault
   and SoSoValue's SSIRFQ, but it does not appear in the public trading docs. ClobGateway can be upgraded by a
   1-of-2 Safe.
6. **Signed POST limits (G4):**
   - the per-IP weight for order POSTs;
   - whether the POST routes carry a Cloudflare rule like the history routes;
   - partner or builder tiers.

   Measure from the executor box on testnet, or ask SoDEX.
7. **Are takeovers published on the firehose (G7)?** Needs one takeover inside a recorded window. The gap detector
   will flag it.
8. **Cause of the failed REST `addAPIKey` txs** (status 0, empty `msg`), for example on account 221909, and the
   actual per-account key limit.

---

## Recommendations for ValueDesk

1. **Re-open the architecture decision.** The copy contract no longer has to be only a registry. Two
   SoDEX-native patterns are proven in production today:
   - **(a) Vault model, following the SLP vault.** Vault (ERC-4626/7540) → strategy → CustodyWallet-style contract
     that owns the SoDEX account → on-chain `addAPIKey(1, "vs-exec-N", executorPubkey)`.
     - Fees are charged in the vault contract, not via builder codes.
     - `revokeAPIKey` is the enforced kill switch.
     - Withdrawals land in the contract.
   - **(b) Per-follower CopyAccount contract.** A minimal contract owned by the follower registers its own SoDEX
     account (1.1 SOSO deposit). It adds the ValueDesk executor key on-chain and lets the follower (and optionally a
     policy/guardian contract) revoke it at any time. SoDEX withdrawals return to the contract, and only the
     follower can pull funds out.
     - Trade-off: no builder fee, unless SoDEX adds on-chain builder approval.
     - Each follower account costs 1 SOSO to activate.
2. **For EOA followers (the default retail path)**, register the executor key with
   **`addPermissionedAPIKey(mask 14)` plus a separate `ApproveBuilderFee`**. That is two wallet signatures, and it
   keeps the builder fee.
   - **Do not use mask 3** (it cannot trade, per the docs).
   - **Do not rely on the one-signature `AddAPIKeyWithBuilder`** if you want a no-withdraw key: it produces a
     full-permission key, as SafePal's keys show.
   - Mark mask-14 enforcement "per docs, unobserved" in all user-facing copy until G2 is closed.
3. **Treat the executor as trading custody, not withdrawal custody** (G5).
   - Guard it with per-follower notional and slippage bounds, market allowlists, and IOC with price caps.
   - Publish the leader tx → follower tx pairs, which clobscan makes auditable.
   - A TEE is recommended for the trading-abuse risk, but it is not required to prevent withdrawals.
4. **Indexer:**
   - record the `trade` firehose from two independent sessions and dedupe on `(engine, symbol, t)`;
   - alarm on any per-symbol `t` hole;
   - drop the 8 CustodyWallet-owned MM accounts at ingest. Derive the list on-chain and refresh it daily with the
     state-override scanner; it takes 77 `eth_call`s.
   - Resolve id→wallet in bulk (`sodex.dev …/users/addresses`) or with the same scanner. Never crawl the
     leaderboard for this.
5. **Copy triggers:** use the firehose, or `accountTrade`, for fills. They are equivalent (median 5 ms apart). Add
   `accountOrderUpdate` for the ≤10 most-copied leaders per egress IP; it gives ~0.4 s median lead on resting
   orders.
6. **Rate budgets:**
   - Plan GET traffic against the **6,000-weight/min header budget**, not 1,200.
   - Pace history routes (`/accounts/{a}/trades`, `/orders/history`) at ≤1 request per 5–10 s per IP because of
     Cloudflare 1015. Prefer the firehose for fills.
   - Keep one shared token bucket per egress IP that reads `x-ratelimit-remaining`.
7. **Latency:** place the executor in Japan (Tokyo or Osaka). Measure from the existing live box first, per the AWS
   hard rule.
8. **Monetisation reality check:** recompute revenue from **non-MM prints only**. 80 % of prints are LP vault
   against LP vault. SafePal already uses builder code 223169, so builder codes are live and competitive.
9. **Ask SoDEX** (partnership agenda, in priority order):
   - on-chain `approveBuilderFee` for contract accounts, or a mask argument on on-chain `addAPIKey`;
   - confirmation of mask-14 semantics and of INTERNAL rejection;
   - long-term support of contract-owned accounts;
   - POST and Cloudflare limits for a fan-out executor;
   - latency of on-chain key propagation.

---

## Appendix — reproducibility (all read-only)

Scripts are in the session scratchpad (`…/scratchpad/g/`):

| Script | What it does |
|---|---|
| `lib.mjs`, `rec.mjs` | JSON-RPC helpers; clobscan fetch; Go-field-order payload rebuild; EIP-712 `ExchangeAction` signer recovery. Domain `futures`/`spot`, chainId 286623 |
| `asm.mjs`, `sim.mjs`, `sim2.mjs` | Hand-assembled forwarder and orchestrator bytecode for the `eth_call` / `eth_simulateV1` state-override simulation of contract registration and key add/revoke |
| `codescan.mjs` | Scanner contract that exists only inside `eth_call`. It walks account ids, resolves owners and reports owners that have code |
| `keyscan.mjs` | API-key scan of 3,786 wallets, doubling as the G4 load test (`keyscan.ndjson`, `ratelog.ndjson`) |
| `w.mjs`, `cf.mjs` | Per-route weight measurement; Cloudflare 1015 probe |
| `capture.mjs`, `g7.mjs`, `recon.mjs`, `liqwin.mjs` | WS capture, firehose analysis, REST reconciliation, in-window takeover search |
| `permkey2.mjs` | Signer census of account 2056 after its mask-14 key was registered |
