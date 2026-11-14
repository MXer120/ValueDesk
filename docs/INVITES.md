# Referrals and fee credits (2026-11-14)

Owner, 2026-11-14:
- "Introduce fee credits, and each invite that trades gets you builder fee credits."
- "make it so users signing up with it use the underlying referral code of sodex ... they get their valuedesk code
  applied + the underlying sodex code"
- "0 builder fee on their first 100k volume and 25% of valuedesk fees paid as credits forever not 12months. and
  introduce tier 1 2 and three, where the percentage gets 10% and then 5%"
- "We also need our own referral page"
- "Ensure our side of the ref system cant be gamed."

Details were decided here. The terms line at the end needs the owner's sign-off before anything ships.

## How it works

- **The code is the wallet's SoDEX referral code.** Every SoDEX account has one, and SoDEX's public API returns it
  (`biz/referral/public/referralCode`), so every wallet with a SoDEX account has its link at once:
  `valuedesk.so/?ref=<CODE>`. The page reads it from SoDEX directly, and no server of ours makes codes.
- **One link, two bindings.** An invited wallet:
  1. signs once to join on ValueDesk (EIP-712, free);
  2. is offered the same code on SoDEX (sodex.com/join/CODE), only when SoDEX says it has no referrer.
  Wherever VALUEDESK would be offered (popup, first-signup step, Profile), a wallet that came on a link is offered
  its inviter's code instead.
- **Welcome.** A joined wallet pays no ValueDesk builder fee on its first **$100,000**. All its SoDEX fills since the
  join day count, wherever it traded, so trading elsewhere cannot stretch the welcome. The builder verifier's sweep now
  also adds every fill's notional to a `traded` table.
- **Three tiers, forever.** Of the ValueDesk builder fees a wallet really pays (the builder ledger's counted orders):
  - **25%** go to its inviter;
  - **10%** go to the inviter's inviter;
  - **5%** go to the next one up.

  This lasts as long as the wallet trades.
- **Credits** pay only the wallet's own ValueDesk builder fee. While they last, its fee is 0.1 bp on every product,
  and the rest of what it would have paid comes off the balance. They are never paid out and never moved.
- **Referrals page** (`/referrals`, under More), laid out like the reference screenshot:
  - left: the link, a "how it pays" banner, stats and a referrals table;
  - right: credit balance, credits earned, the welcome, and credit history.

  There is nothing to claim: credits apply by themselves.

## Why it cannot be gamed

- **Who owns a code** comes from SoDEX itself, so nobody can attach someone else's code.
- **Joins that are refused:**
  - the wallet's own code;
  - ValueDesk's own code;
  - a wallet that has traded on ValueDesk;
  - a wallet that has referrals of its own (so no loops can form, and a chain only grows downwards);
  - a second join (the first one stands).
- **Same browser:** codes of wallets this browser has connected are never kept or offered, which blocks casual
  self-invites.
- **Credits come only out of fees really received:** together at most 40% (25 + 10 + 5) of a referral's fees. So
  ValueDesk always keeps at least 60%, and no wallet can earn more than it brings in.
- **No runaway lowered fee:**
  - The 0 bp welcome and the 0.1 bp credit fee are handed out 3 minutes at a time: the signed terms end with them,
    and the executor asks again within that time.
  - The executor gets a budget with them: what is left, what each dollar uses up, and up to when the ledger has read
    the wallet's fills. It counts its own bot and copy fills after that and stops at the budget.
  - Credits switch on only when they cover 15 minutes of the wallet's own recent pace. A trickle of credit therefore
    never opens 0.1 bp to a fast trader's burst.
  - Anything that still runs over goes to a negative balance, which the next credits repay first.
- **Welcome farming is bounded:**
  - at most 50 welcomes per inviter per 30 days;
  - each welcome needs a fresh wallet with its own SoDEX deposit (SoDEX has no transfers between wallets);
  - a join past the cap still counts for credits, without the welcome.
- **Where it can't be enforced:** a page can always be bypassed, just as anyone can trade on sodex.com and pay no
  ValueDesk fee. The fee is enforced exactly where ValueDesk places the orders (copy trading, bots).

What remains possible: one person can invite their own fresh wallets. That earns them at most 25/10/5% of fees they
pay themselves, plus one capped welcome per wallet. The terms line below lets ValueDesk withhold credits for that.

## Cost (builder ledger on server 1, read-only, 2026-11-14)

**Last 30 days**

| Item | Amount |
|---|---|
| Builder fees received | **$7.86** |
| Counted volume | $198,636 (12 wallets) |

**Volume by fee rate**

| Fee rate | Volume |
|---|---|
| 0.4 bp (bots) | $178,958 |
| 0.1 bp | $16,598 |
| 1.5 bp (site) | $2,359 |
| 2.5 bp (copy) | $720 |

- **Credits:** at most 40% of referrals' fees. Even if every paying wallet sat three deep under referrers, that is
  about **$3 a month** at today's revenue. Credits cost nothing until a referral pays fees.
- **Welcome:** per joined wallet that trades $100k, ValueDesk gives up:
  - **$4** on bots (0.4 bp);
  - **$15** on futures (1.5 bp);
  - **$25** on copies (2.5 bp).

  The cap bounds one inviter to $750 a month in futures welcomes.
- **Overrun:** about 3 minutes of the wallet's own trading at most, bounded by the executor budget where ValueDesk
  trades. It is repaid from the next credits.

## Where it lives

**Server:**
- `apps/server/src/invites/`:
  - `claim.ts`: rules and typed data;
  - `check.ts`: the signature check;
  - `sodex.ts`: the code's owner from SoDEX;
  - `store.ts`: `invites.db`;
  - `service.ts`: tiers, welcome, switch, perkBudget.
- `routes/invites.ts`: `/api/vs/invites/{check,me,join}`.
- BuilderService: `setExtraPrograms`, `setPerkBudget`, `standardFee`. `/api/vs/builder/volume` sends the budget with
  invite perks.
- BuilderStore: `traded`, `tradedMicro`, `readThrough`, `oldestOpen`; the verifier fills `traded`.

**Executor:**
- `service.ts`: `noteFill` / `budgetSpent` / `readBudget`.
- copy and algo runtimes: an `onFill` host hook.

**Web:**
- `invites/`: capture, own code, join, `useSodexCode`.
- `InviteHost`: the two-step popup.
- `components/referrals/`: the page.
- Savings: bot fees only, with VIP in gold and staking in the same element.
- Share cards: the sharer's code.

**Analytics:** `invite.copy`, `invite.bind`, `credits.earn`.

**Backups:** add `invites.db` to the off-server backup with `profiles.db` before it holds real credits.

## Terms, for sign-off (section 6, ValueDesk builder fee): NOT in the terms yet

> **Referrals and fee credits.** A wallet that has not traded through ValueDesk yet may join with another wallet's
> referral link by signing once with its wallet. It then pays no ValueDesk builder fee on its first $100,000 of
> volume after joining (all its volume on SoDEX counts). Of the ValueDesk builder fees a joined wallet pays, the wallet
> that referred it receives 25% as fee credits, that wallet's referrer 10%, and the next one up 5%, for as long as the
> joined wallet trades. Fee credits are not money: they cannot be paid out, transferred or exchanged, and they only pay
> the receiving wallet's own ValueDesk builder fee, which is 0.1 bp while it has credits (the rest of the fee it would
> have paid is taken from them). SoDEX's own fees and SoDEX's own referral programme are not affected. Referring
> yourself or wallets you control, or any attempt to obtain credits or the fee waiver by other means than genuine
> referrals, is not allowed; we may then withhold or remove credits and end the waiver. We may change or end the
> programme for future fees; credits already earned remain usable.

Still for the owner to decide:
- whether unused credits should expire (not built);
- the welcome cap of 50 per inviter per 30 days;
- a legal check of a referral reward in the owner's jurisdiction.
