# @valuescan/sodex-core

This package signs SoDEX requests in the browser. It covers:

- EIP-712 action signing and API-key signing, byte-identical to the official SoDEX Go SDK.
- Builder codes.
- Cross-tab nonce management.
- Request assembly.
- Decimal canonicalisation.
- REST and WebSocket response types.

It is ported from Opentrade's verified server code (`server/src/signing/*`, `decimal.ts`, `sodex/symbols.ts`, and parts of `sodex/rest.ts` and `sodex/ws.ts`) and extended.

The package has three limits by design:

- **Pure TypeScript and `@noble/*` only.** `src/` compiles with `types: []` and no DOM lib, so there is no `node:*`, no `Buffer` and no `window`. A test also scans the source for these.
- **It never sends anything.** It builds `{method, path, headers, body}` and your code calls `fetch`. There is no `fetch` in `src/`.
- **Keys live in memory only.** Nothing here writes to storage, except the nonce high-water mark, which is a number and not a secret.

```ts
import { perpsActions, signAndBuildWithNonceManager, createNonceManager } from '@valuescan/sodex-core';
```

## API

### Exchange actions (the API key signs, prefix `0x01`, domain `futures` or `spot`)

```ts
const action = perpsActions.newOrder(accountID, symbolID, [
  { clOrdID: 'vs-1', side: OrderSide.BUY, type: OrderType.MARKET, timeInForce: TimeInForce.IOC,
    price: '70010.5', quantity: '0.01' },              // decimals are STRINGS
], { id: BUILDER_ACCOUNT_ID, fee: 50 });              // optional builder (tenths of a bp)

const nonces = createNonceManager();                  // Web Locks + localStorage + BroadcastChannel
const req = await signAndBuildWithNonceManager(action, key, { chainId: 286623, nonces });
// req = { method: 'POST', path: '/sodex/api/v1/perps/trade/orders', headers, body, meta }
const res = await fetch(req.path, { method: req.method, headers: req.headers, body: req.body });
const data = parseEnvelope(res.status, await res.text(), req.gatewayPath); // throws on {code != 0}
```

- **Builders.** `perpsActions.*` and `spotActions.*` cover newOrder, cancelOrder, modifyOrder, replaceOrder, scheduleCancel, updateLeverage, updateMargin, transferAsset, and newTwapOrder/cancelTwapOrder. Spot uses batchNewOrder and batchCancelOrder. The raw param builders (`perpsNewOrder`, `spotBatchNewOrder`, and so on) emit keys in Go struct field order, and `ENDPOINTS` / `endpointFor` map each action to its route.
- **`signAndBuild(action, key, { chainId, nonce, base?, now? })`** is synchronous and pure. It throws if the key has expired (`expiresAt` is in **milliseconds**), if the nonce is outside the window, or if the action does not exist on that engine.
  - The **body is not the signing payload.** The signature covers `keccak256(goJSON({type, params}))`, while the body is `params`, serialised once.
  - Header names match Opentrade and the Go SDK exactly: `X-API-Key` (the key *name*), `X-API-Sign`, `X-API-Nonce` and `X-API-Chain`. `X-API-Key` is omitted when `key.name` is absent, which is how the master wallet signs directly.
- **`signingKeyFrom(tradingKey, {name, expiresAt})`** binds a generated key to its registration. The `privateKey` stays non-enumerable, so it is left out of JSON output and object spreads.
- **Builder fees.** `builderFragment` enforces the caps: perps 0..200, spot 0..2000, and `id` must be non-zero. On perps the builder goes at batch level (`builder` last, after `orders`) or per order (the last key of the order). On spot it goes at batch level, after `orders`.

### Key lifecycle (the master wallet signs typed data)

```ts
const tk = generateTradingKey();                       // CSPRNG, memory only, non-enumerable secret
const prepared = prepareApiKeyRegistration({
  userAddress, accountID, name: generateApiKeyName(), publicKey: tk.address,
  expiresAt: expiryFromNow(DEFAULT_TRADING_KEY_TTL_MS), // 24 h; the policy refuses 0, seconds, and > 7 d
  builder: { id: BUILDER_ACCOUNT_ID, maxFeeRate: 50 },  // optional; one signature = key + builder approval
  nonce: await nonces.next(nonceKey(userAddress, 286623)),
  sodexChainId: 286623, signatureChainId: walletChainId,
});
const sig = await provider.request({ method: 'eth_signTypedData_v4',
  params: [userAddress, JSON.stringify(prepared.typedData)] });
const req = assembleWalletSignedRequest(prepared, sig);  // v 27/28 -> 0/1, prefix, RECOVERS the signer
```

| Function | Signs | Route | Confidence |
|---|---|---|---|
| `prepareApiKeyRegistration` (no builder, no permissions) | `AddAPIKey` (domain chainId = SoDEX network id) | `POST /api/v1/user/{addr}/api-keys` | documented |
| `prepareApiKeyRegistration({builder})` | `AddAPIKeyWithBuilder` (domain = wallet chain, message `chainID` = 286623/138565) | same | documented |
| `prepareApiKeyRegistration({permissions})` | `UserSignedAddPermissionedAPIKeyAction` | same | documented |
| `prepareEngineApiKeyRegistration` | `UserSignedAddPermissionedAPIKeyAction` | `POST /api/v1/{engine}/accounts/api-keys` (Opentrade `routes/wallet.ts`) | Opentrade legacy |
| `prepareBuilderFeeApproval` | `ApproveBuilderFeeAction` (`maxFeeRate` 0 clears) | `POST /api/v1/user/{addr}/builders` | documented |
| `prepareApiKeyRevocation({route:'engine-delete'})`, `...BothEngines` | `ExchangeAction` `revokeAPIKey`, engine domain, `0x01`, master wallet | `DELETE /api/v1/{engine}/accounts/api-keys`, once per engine | documented, **route unverified** |
| `prepareApiKeyRevocation({route:'engine-post-revoke'})` | same | `POST /api/v1/{engine}/accounts/api-keys/revoke` (Opentrade) | **undocumented, unverified** |
| `prepareApiKeyRevocation({route:'user-delete-universal'})` | `ExchangeAction`, universal domain, `0x02` | `DELETE /api/v1/user/{addr}/api-keys` (Python SDK) | **contradicts the docs, unverified** |

Each prepared action carries `typedData` (hand it to the wallet), `digest`, `caveats[]`, `confidence` and the request without `X-API-Sign`. Lower-level typed-data builders are `addAPIKeyTypedData`, `addAPIKeyWithBuilderTypedData`, `permissionedAPIKeyTypedData`, `approveBuilderFeeTypedData` and `exchangeActionTypedData`. `hashTypedData` hashes any flat typed-data object exactly as a spec-compliant wallet does.

### Permissions (`permissions.ts`): the corrected model

`permissions` is a **disable** mask: `TRADE=1`, `CANCEL=2`, `WITHDRAW=4` and `TRANSFER=8`, and **a set bit disables that right**. An absent mask means an ordinary key, with *every* right enabled.

- `assertPermissionedMask` enforces the documented rule that a permissioned key **must disable TRADE or CANCEL**. So "trade + cancel but no withdraw" (mask 12) **cannot be registered today**.
- `assertRegistrationScope` enforces **builder XOR permissions**.
- `describeKeyScope` and `ORDINARY_KEY_SCOPE` give the honest wording for the UI.
- Opentrade's old "mask 3 = TRADE|CANCEL" is inverted. Mask 3 disables trading and *leaves withdraw and transfer enabled*. Nothing here ports that assumption.

### Nonces (`nonce.ts`)

`createNonceManager()` hands out millisecond nonces per signing key that are strictly increasing and unique across tabs (key: `nonceKey(address, chainId)`). It works in three layers:

1. **Web Locks** serialise allocation.
2. **localStorage plus BroadcastChannel** share the high-water mark between tabs.
3. **A clock fence** holds the lock until the clock passes the issued nonce. This keeps tabs unique even when storage propagates late.

It enforces the documented window `(now − 2 d, now + 1 d)` with a 60 s margin. `createMemoryNonceManager()` is the in-memory fallback for a single tab or process. `withNonce(key, fn)` keeps the lock held while `fn` sends, for callers that need wire order.

### Other modules

- **`decimal.ts`:** `canonicalDecimal`, `decimalCompare`, `roundToStep` and `numberToPlainString`. It matches shopspring/decimal and never uses exponent notation.
- **`symbols.ts`:** `normaliseOrder` (tick and step snapping, min/max, notional and funds checks before signing), `mulDecimal` and `resolveSymbol`. All are pure; you pass in the symbol list.
- **`envelope.ts`:** `parseEnvelope`, which rejects HTTP-200 error envelopes and never returns them as empty pages, plus `SodexApiError.hint`, `unwrapList`, `failedOrders`, `isTransientFailure` (for **reads only**; never replay a signed write) and `weightFor` (the measured weights).
- **`types/rest.ts`, `types/ws.ts`:** response shapes, checked against live mainnet reads on 2026-09-25. For example, a position's side arrives as `positionSide`, not the schema's `side`, and API-key `type` is the string `'EVM'`. `types/ws.ts` also has the measured WS channel parameter matrix (`normaliseSubParams`, `subKey`).

## Verified vs unverified

**Verified byte-for-byte against the official Go SDK.** The vectors are generated by `tools/genvectors` from `sodex-go-sdk-public@66b00c07` (2026-07-21) and pinned in `test/vectors-sdk.json` and `test/vectors-sdk.commit`:

- Opentrade's **19 original vectors** (`test/vectors.json`, copied verbatim). Today's SDK still reproduces them exactly, and a test asserts that.
- Perps orders with a **batch-level builder**, including a market IOC order with a price cap at the 200 fee cap, and spot batches with a builder. These use official structs and the official signer.
- **AddAPIKey** (the ordinary key), **AddAPIKeyWithBuilder** (with the wallet on chain 1 and on the network chain), and **ApproveBuilderFeeAction** (approve and clear). These cover the digests and the `0x02` wire signatures, *and* the typed-data **objects** handed to wallets, which hash to the same digest.
- TWAP new and cancel, and the spot revoke payload.
- Go `encoding/json` string escaping: HTML characters, `\b`, `\f`, U+2028 and U+2029. Decimal canonicalisation on 27 cases.

**Pinned, but only half-official.**

- The perps **per-order builder override.** The Go SDK has no such field. Its layout (the last key of the order, after `positionSide`) comes from the Python SDK (2026-09-08) and the builder-codes doc. The bytes are Go `encoding/json` plus the official signer over a local struct.
- The **universal-domain revoke** (the Python SDK route) is composed from SDK primitives.

**Unverified: nothing in this package has been sent to a gateway.**

- Whether the gateway accepts any of the routes above as assembled. Opentrade's notes record only that the signature layer of the legacy engine route was accepted on testnet in Aug 2026.
- Which revocation route works. The docs say `DELETE /{engine}/accounts/api-keys`, and both Opentrade's `POST …/revoke` and the Python SDK's universal `DELETE /user/{addr}/api-keys` disagree with them.
- Permission-mask **enforcement**. For example, whether a mask-14 key really cannot withdraw.
- The real scope of an ordinary key: "moves funds only between the owner's own engines and EVM wallet". This is documented and inferred, not observed.
- What rights a key registered via `AddAPIKeyWithBuilder` gets. `builder` excludes `permissions`, so it is presumably an ordinary key.
- Wallet UX. MetaMask rejects typed data whose domain chainId is not the active chain. Ordinary `AddAPIKey` and the engine-domain revoke use the SoDEX chain id (286623) in the domain, so the wallet must be on ValueChain for them. `AddAPIKeyWithBuilder`, `ApproveBuilderFee` and the permissioned action use the wallet's chain and avoid this.

## Security notes

- **Memory-only keys.** `generateTradingKey()` uses `crypto.getRandomValues`. The secret is non-enumerable, and `destroyTradingKey` zeroes it. Never persist it. The only persisted value is the nonce high-water mark.
- **Short expiry.** The default is 24 h (like sodex.com's own web key). `assertShortExpiry` refuses `0` ("never"), values that look like **seconds**, anything under 5 minutes, and anything over 7 days unless you override it explicitly. Local expiry checks compare milliseconds against milliseconds; Opentrade's browser signer compared them against seconds, so its keys never expired locally.
- **The real blast radius of the browser key.** It is an **ordinary** key, because the only restricted keys SoDEX allows cannot trade.
  - Per SoDEX docs (unverified), whoever holds it can place and cancel orders, change leverage and margin, and **move funds between the owner's own spot engine, perps engine and the owner's own EVM wallet**.
  - SoDEX documents no way for it to send funds to *another* owner. Withdrawals land on the owner's EVM address, and external withdrawals need the owner's own permit.
  - The residual risk is adversarial trading: a stolen key can trade the balance at bad prices on thin books.
  - The UI must say all of this: use `ORDINARY_KEY_SCOPE` or `describeKeyScope`.
- **The master wallet signs only typed data** (registration, builder approval and revocation). `assembleWalletSignedRequest` recovers the signer and refuses a signature from any address other than the account owner.
- **Key names are public.** Anyone can list an address's keys, so key names must not contain anything identifying.
- **Never retry a signed write.** A timeout is not evidence that the engine did not act. `isTransientFailure` is for GETs only.
- **The builder-fee approval is a ceiling, not a payment.** At most 10 approvals per user, and the builder needs at least 100 vUSDC in *both* engines.

## Develop

```bash
npm test                      # tsx --test test/*.test.ts   (141 tests)
npm run typecheck             # src (no Node/DOM typings) + tests (Node typings)
bash tools/genvectors.sh      # regenerate test/vectors-sdk.json from the official Go SDK (needs Go + network once)
```

`tools/.cache/` is git-ignored and holds clones of `sodex-go-sdk-public` (used for the vectors) and `sodex-python-sdk-public` (used as field-order evidence).
