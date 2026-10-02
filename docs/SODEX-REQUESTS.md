# Requests to SoDEX

Things only SoDEX can change. Each is written so it can be sent as it stands.

## 1. Bind a builder to an API key

**Why we ask.** A builder fee is set per order by whoever builds the order. A frontend can make sure its own
code always attaches it, but a user who edits that code, or signs with the same key from their own script,
can leave the builder out and SoDEX accepts the order. The builder can find out afterwards - the public
explorer returns each order's signed action, so the signing key can be recovered - but it cannot prevent it.
See [BUILDER-TIERS.md](BUILDER-TIERS.md) §1.

**What we ask for.** An optional binding at key registration:

- `AddAPIKeyWithBuilder` (or a new flag on it) registers a key that may **only** place orders naming that
  builder, at a fee of at least a minimum set in the same signed message (`minFeeRate`), and at most the
  approved maximum. An order from that key without the builder, or below the minimum, is rejected.
- The binding is part of what the user signs with the master wallet, so the user sees and accepts it. It ends
  when the key is revoked or expires. Keys registered without it behave as today.
- Replace and modify keep the order's builder (or accept a `builder` field), and TWAP orders accept a
  `builder` field, so a bound key has no order type that escapes the binding.

**What it changes.** A user can still trade without any builder by registering their own key on sodex.com.
What ends is using a builder's application - its key, its interface - without paying the builder.

## 2. Name the signing key on order records

`GET /accounts/{address}/orders/history` (and the order update stream) could carry the name of the API key
that signed the order. A builder could then see, from one read, which orders its application placed, and
reconcile them against the orders that named it. Today that takes one explorer request per order
(`clobscan .../transaction?account_id=&order_id=`) and recovering the signer from the signature.

## 3. A builder's own fills

A read for the builder account listing the fills that paid it (payer account, order id, trade id, notional,
fee, time) - today `accountUpdate` shows only the balance moving, with no reason, and attributing income to
users needs each user's order history, which is limited to about four requests a minute per IP.

## 4. Smaller things noticed while integrating

- `AddPermissionedAPIKeyRequest` cannot carry `builder`, so a restricted key plus a builder approval is two
  wallet signatures. One combined action for the restricted key would halve the prompts.
- The documented plain `AddAPIKey` registration is rejected on mainnet; the web app's
  `UserSignedAddAPIKeyAction` on `/exchange` works. The documentation could say which one is current.
