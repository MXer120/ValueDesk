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

## 5. A fee group for a builder's flow (fee tier and staking)

*Not sent: the owner dropped this request on 2026-10-29. Kept for the record.*

**Why we ask.** SoDEX's fee tier is per user and needs more than $5 M of 14-day volume for the first step. Most of
our users trade far less, so every one of them pays tier 0 (4.0 bp taker) plus our builder fee. Together they
trade through one builder.

**What we ask for.** Orders that carry builder 234812 are charged at the tier of the builder's combined 14-day
volume over those orders (or at a fixed rate agreed for the builder), while each user keeps trading in their own
account. A user's own tier applies when it is better. As an alternative, a rebate of the difference paid to the
builder, which we pass on to the users.

**Group staking.** The SOSO each member stakes in their own wallet on SSI Earn, plus the builder's own stake, add up
to one staking discount for the group: 1,000 members with 30 SOSO each reach the 20 % step together. Nothing leaves
anyone's wallet. Each member pays the better of their own tier and discount and the group's.

**Limits SoDEX may set.** Only fee-paying fills count, self-matches are excluded, the group can be capped at a tier,
and SoDEX can end the group.

**What it changes.** Users get a lower fee without handing anyone their funds, and SoDEX gets the volume that a
lower fee brings. Without it, the next way is §6; the last is to pool users' funds into one account (§7-9), which
moves custody and the users' margin into one account. We would rather not do that.

## 6. Member sub-accounts bound to the member

We hear sub-accounts are coming to SoDEX. ValueDesk would use them under a contract-owned parent account, one
sub-account per user: all members share the parent's fee tier, and each keeps their own margin, keys and money.
What we need to know, and to ask for where it is not planned:

1. Can a contract-owned parent create sub-accounts through the gateway, one for each wallet that asks?
2. Can keys on a sub-account be registered by the member's own signature, or by the parent for that one
   sub-account only, so the key cannot sign for any other account?
3. Where does a sub-account's withdrawal land? We need it paid to the member, or to the parent with the
   sub-account's id in the `Withdraw` event, so our contract pays exactly that member.
4. Can deposits be credited to a sub-account directly?
5. Can a member detach their sub-account into an ordinary account of their own, open positions included?
6. Do sub-accounts share the parent's fee tier and staking discount ("each user has a single fee tier")?
7. Are API keys (5 per master account today), open orders (1,000 per user) and address-based actions counted per
   sub-account?
8. Are two sub-accounts of one parent trading with each other an ordinary trade, not a self-trade, for self-trade
   prevention and surveillance?
9. Is each sub-account margined and liquidated on its own, like any account?
10. How many sub-accounts may one parent hold? We need one per user, so thousands; Hyperliquid caps a master at 50.

## 7. Restricted keys for contract accounts

§7-9 matter only for a shared pool account, if §6 is not possible.

`addAPIKey` on the gateway takes no permissions and no expiry. We ask for the same restrictions the REST
registration has, and two more: a trade-only key that cannot withdraw or transfer, and a close-only key (reduce-only
orders and cancels) for a rescue party.

## 8. A close-and-withdraw call from the owning contract

An EVM-side gateway call, usable only by the contract that owns the account: cancel all orders, close all positions
reduce-only at the market, withdraw the balance to the contract. A contract could then let its users leave after a
timelocked outage of its operator without anyone holding a key - the exit Hyperliquid contracts already have.

## 9. Limits for a pooled account

A pooled account carries many users: more than 5 API keys (one per signing process), and higher order-rate,
open-order (1,000 per user) and address-action limits than one person needs, as SoDEX's market-maker accounts have.
