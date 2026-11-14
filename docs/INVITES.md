# Invites and fee credits (2026-11-14)

Owner: "Introduce fee credits, and each invite that trades gets you builder fee credits." / "redesign the savings page."
/ "For fee tier, needs to show both sodex fee tier, our fee tiers, the fee credits." Details decided here; the terms
line at the end needs the owner's sign-off before anything ships.

## How it works

- **Link.** `valuedesk.so/?i=<code>`. A wallet's code is 8 random characters (no look-alikes), made by the server the
  first time the wallet asks (no signature: a code only ever earns for its own wallet). Share cards carry the sharer's
  code on their link.
- **Joining.** The page keeps `?i` (checked with the server) in the browser and takes it off the address bar. Once the
  wallet accepted the site terms it is offered to join: one free EIP-712 signature (`ValueDesk Invite`, statement
  "Join ValueDesk with this invite."). Server rules: never the wallet's own code; only a wallet the builder ledger has no
  volume for; the first join stands. SoDEX's VALUEDESK referral is separate and keeps its own rules.
- **Earning.** The inviter earns 25% of the builder fees each invitee really pays (the builder ledger's counted orders:
  counted volume x the fee the order named), for 12 months from the join. Self-funded by construction: credits are a
  share of fees ValueDesk received.
- **Spending.** While a wallet has credits (on at $0.05, off at $0), its builder fee is **0.1 bp** on every product
  (futures, spot, copy, bots) and the fee it would have paid above that comes off the balance, valued at its tier /
  ladder step now. Never paid out, never transferred.
- **Welcome.** The invited wallet's builder fee is 0.1 bp on its first $10,000 of counted volume.

**Why 0.1 bp, not 0.** The builder ledger counts a wallet's volume only on orders that paid a builder fee
(builder/counting.ts). At 0 nothing would count: not the welcome's $10k (it would never end), not what credits paid
(nothing to deduct), not the wallet's own volume toward its tier and VIP. 0.1 bp is the smallest fee SoDEX can carry.

## Cost (builder ledger on server 1, read-only, 2026-11-14)

| Last 30 days | |
|---|---|
| Builder fees received | **$7.86** |
| Counted volume | $198,636 (12 wallets) |
| By fee: 0.4 bp (bots) | $178,958 |
| 0.1 bp | $16,598 |
| 1.5 bp (site) | $2,359 |
| 2.5 bp (copy) | $720 |

- **Credits:** at most 25% of the fees invited wallets pay. Even if every paying wallet had been invited: about
  **$2 a month** at today's revenue. They cost nothing until an invited wallet pays fees.
- **Welcome:** per invited wallet that trades $10k, ValueDesk gives up (its fee - 0.1 bp) x $10k: **$0.30** on bots
  (0.4 bp), **$1.40** on futures (1.5 bp), **$2.40** on copies (2.5 bp). Only for wallets with no ValueDesk volume yet.
- **Overrun:** credits keep paying until the credit job (every 60 s, main API) sees the balance at 0, plus the builder
  ledger's counting delay (the explorer check of each order) and the signed fee's TTL (10 min). What is traded in that gap
  is spent like any other fee: the balance goes below 0 and the next credits pay it back first. Example: a wallet
  trading $100k a day of futures pays $15 a day in fees; a 20-minute gap is about **$0.21**.

## Where it lives

- Server: `apps/server/src/invites/` (claim.ts rules + typed data, check.ts signature, store.ts `invites.db`,
  service.ts the credit job), `routes/invites.ts` (`/api/vs/invites/{code,check,me,join}`), BuilderService
  `setExtraPrograms` / `standardFee` (credits and the welcome are fee programs like the dev page's), BuilderStore
  `countedOrders`. Analytics: `invite.copy`, `invite.bind`, `credits.earn`.
- Web: `invites/` (capture, store, join), `InviteHost` (the join popup), Savings page (`SavingsFees`, `SavingsCredits`),
  share cards' links.
- Backups: add `invites.db` to the off-server backup with `profiles.db` before it holds real credits.

## Terms, for sign-off (section 6, ValueDesk builder fee) - NOT in the terms yet

Proposed bullet:

> **Invites and fee credits.** A wallet that has not traded through ValueDesk yet may join with another wallet's
> invite link by signing once with its wallet. Its ValueDesk builder fee is then 0.1 bp on its first $10,000 of volume
> counted through ValueDesk. The wallet that invited it receives fee credits of 25% of the ValueDesk builder fees the
> invited wallet pays in the 12 months after it joined. Fee credits are not money: they cannot be paid out, transferred
> or exchanged, and they only pay the inviting wallet's own ValueDesk builder fee, which is 0.1 bp while it has credits
> (the rest of the fee it would have paid is taken from them). SoDEX's own fees are not affected. We may change or end
> the programme for future fees; credits already earned remain usable.

Open for the owner: whether unused credits should expire (e.g. 12 months after they were earned; not built), and the
legal check of a referral reward in the owner's jurisdiction.
