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
- **A referral is never lost on one step** (2026-11-25: until then `/?ref=CODE` lost its code in the router, and not one
  join was recorded in ten days). Independent ways, whichever comes first:
  1. the code is kept before anything renders (`web/src/invites/capture.ts`: memory, tab, browser) and goes along into a
     phone wallet's browser; an unanswered check keeps it;
  2. the terms signature joins: the terms window shows the code (`joinByTerms`, server `checkTermsJoin`), sent until the
     server answers;
  3. the popup's own signature, on every visit until it is answered, with retries;
  4. the SoDEX check (`InviteService.autoTick`): a new wallet whose SoDEX inviter used ValueDesk before it joins by
     SoDEX's word, whatever its browser lost.
  Volume blocks a join only after 24 h, and not when SoDEX names the same inviter. `counts` in invites.db and the health
  check `referrals` alert when links are opened and nobody joins. Lost ones: `apps/server/tools/invites-restore.ts`.
- **Welcome.** A joined wallet pays no ValueDesk builder fee on its first **$100,000**. All its SoDEX fills since the
  join day count, wherever it traded, so trading elsewhere cannot stretch the welcome. The builder verifier's sweep now
  also adds every fill's notional to a `traded` table.
- **Three tiers, forever.** Of the ValueDesk builder fees a wallet really pays (the builder ledger's counted orders):
  - **15%** go to its inviter;
  - **5%** go to the inviter's inviter;
  - **1%** go to the next one up (owner 2026-11-25; was 20 / 7.5 / 2%).
  - An earner that is VIP when the credit is given gets **20 / 7.5 / 2%** instead (owner 2026-11-25). An upgraded code is
    no VIP standing: its owner earns the normal shares.

  This lasts as long as the wallet trades.
- **Credits** pay only the wallet's own ValueDesk builder fee. While they last, its fee is 0.1 bp on every product
  (futures and spot on the site, copy trading, bots: owner 2026-11-15 "apply for all builder fees not only bots"), and
  the rest of what it would have paid comes off the balance. Bots > Savings has a card for them and the link. They are never paid out and never moved.
- **VIP codes** (owner 2026-11-25): a wallet that joins with the code of a VIP wallet (volume, kept, a VIP program, the
  beta's 30 days) pays the VIP fee, the lowest tier of every product, for 7 days from its join. The dev page (Fees) can
  upgrade any code to do the same. The days are a fee, not VIP: the wallet's own code is no VIP code for it.
- **VIP credit**: removed 2026-11-25 (owner). Nobody is given any, and what was left of one is gone; what it had paid
  stays paid.
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
- **Credits come only out of fees really received:** together at most 29.5% (all three VIP: 20 + 7.5 + 2; else 21%) of a referral's fees. So
  ValueDesk always keeps at least 70%, and no wallet can earn more than it brings in.
- **No runaway lowered fee:**
  - The 0 bp welcome and the 0.1 bp credit fee are handed out 3 minutes at a time: the signed terms end with them,
    and the executor asks again within that time.
  - The executor gets a budget with them: what is left, what each dollar uses up, and up to when the ledger has read
    the wallet's fills. It counts its own bot and copy fills after that and stops at the budget.
  - Credits switch on only when they cover 15 minutes of the wallet's own recent pace. A trickle of credit therefore
    never opens 0.1 bp to a fast trader's burst.
  - Anything that still runs over goes to a negative balance, which the next credits repay first.
- **Invites have no limit** (owner 2026-11-25; was 50 welcomes per inviter in 30 days). Welcome farming is bounded only by:
  - each welcome needs a fresh wallet with its own SoDEX deposit (SoDEX has no transfers between wallets).
- **Where it can't be enforced:** a page can always be bypassed, just as anyone can trade on sodex.com and pay no
  ValueDesk fee. The fee is enforced exactly where ValueDesk places the orders (copy trading, bots).

What remains possible: one person can invite their own fresh wallets. That earns them at most 20/7.5/2% of fees they
pay themselves, plus one welcome per wallet, without a limit on wallets. The terms line below lets ValueDesk withhold credits for that.

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

**Localhost:** 5180 reads production's API, which has no referral routes until they are released. The page then said
"Could not read your referrals"; it now says the stats aren't on this server yet. For the real thing locally, start the
launch config `invites-dev` (`apps/server/tools/invites-dev.ts`, 127.0.0.1:18797). It runs the real routes on a local
`invites.db`, with no builder ledger, and asks production whether a wallet is VIP. Vite sends `/api/vs/invites` there
while it answers.

## Verified (2026-11-14)

- **Server** (`test/invites.test.ts`, `test/invitesFeePath.test.ts`, the `traded` test in `builderVerifier.test.ts`):
  - SoDEX code owner;
  - join rules: self, ValueDesk's code, volume, referrals, second join, forged signature;
  - welcome cap; three tiers forever; spend; the cover rule; overrun;
  - on the real BuilderService: a joined wallet signs 0 bp in short terms, and the executor's read carries the
    welcome budget; after $100k of traded volume it is back on its tier;
  - the VIP $5, given once (sweep, page, restart), lowers the signed fee to 0.1 bp and comes with a credits budget;
  - fills without a builder fee are counted into `traded` once, across overlapping sweeps.
- **Executor** (`test/volume.test.ts`, `test/perk-budget.test.ts`): the lowered fee holds until its own fills after
  the ledger's read use the budget up, for both welcome and credits; an unreadable budget gives no lowered fee.
- **Engine** (`algo-bots.test.ts`): a bot's real fill reaches the executor's budget hook with its notional.
- **Browser** (`e2e/ui/referrals.spec.ts`, real Edge, desktop and phone, a throwaway wallet that really signs, local
  referral routes):
  - `?ref=` is kept and taken off the address;
  - the popup shows the code and the $0 welcome, and never VALUEDESK over the inviter's code;
  - one InviteJoin signature joins, and nothing else is signed;
  - step 2 links to sodex.com/join/CODE;
  - the page shows "Referred by", the welcome, and the no-SoDEX-account link state;
  - the page opens from More without a wallet.

Not verified:
- a funded wallet's real join and fees on production data (needs the release);
- binding on sodex.com (SoDEX's own page);
- the executor on server 2 with a live budget.

## Terms, for sign-off (section 6, ValueDesk builder fee): NOT in the terms yet

Owner, 2026-11-14: "needs to be more general so if we change values terms dont need to be resigned". So the line
names no amount, share, rate, cap or level count. Like section 6's own "the tiers are shown in the app and may change
for future orders", it points to the Referrals page. Every current value is listed there, read from the same rules the
server applies (`claim.ts`): the How it works dialog. Changing a value is then a release, never a new terms version.

Proposed bullet for section 6:

> **Referrals and fee credits.** You may join ValueDesk through another wallet's referral link, once and before you
> trade through ValueDesk, by signing with your wallet. A wallet that joined may pay a lower ValueDesk builder fee, or
> none, on part of its volume, and the wallets that referred it may receive fee credits: a share of the ValueDesk
> builder fees it pays. We may also give fee credits for other reasons, for example to VIP wallets. Who qualifies, the
> amounts, the shares, the limits and the fee that applies while credits are used are shown on the Referrals page; they
> may change for future fees without changing these terms. Fee credits are not money: they cannot be paid out,
> transferred or exchanged, and they only pay your own ValueDesk builder fee. SoDEX's own fees and SoDEX's own referral
> programme are not affected. Referring yourself or wallets you control, or any other way of obtaining credits or a
> lower fee than through genuine referrals, is not allowed; we may then withhold or remove credits and end a lower fee.
> We may change or end the programme for future fees; credits already given remain usable.

Still for the owner to decide:
- whether unused credits should expire (not built);
- a legal check of a referral reward in the owner's jurisdiction.

