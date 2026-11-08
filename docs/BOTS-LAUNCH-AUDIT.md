# Bots: launch audit for whitelisted users (2026-11-08)

Nine read-only reviews of every bots file (engine runtime, engine spec/feeds/sink, executor + server, web New bot,
web bot pages, web overview/explore/VIP, plus backend, data and UX audits) and a walk through the pages. Branch
feat/bots. Paths are relative to the worktree root. "Inferred" = read from code, not reproduced.

Order of work: **A** must be fixed before a single real bot runs for a beta user. **B** before launch. **C** soon after.

---

## A. Blockers: money can be lost or orders/positions left unmanaged

### A1. Orders left on SoDEX with nobody managing them
- Stopping a bot while its key is missing (`sinkFor` null) or a cancel throws: the quotes stay on SoDEX marked
  `cancelling`, ended bots are never stepped, never re-cancelled (`packages/copy-engine/src/algo/runtime.ts:3186-3191, 3283, 585`).
  Fix: reset `cancelling` when there is no sink; re-cancel live children of ended bots on a timer.
- Key expiry/revocation: `keyProblem` drops the signer (`apps/executor/src/service.ts:963-966`) so the bot cannot pull
  its quotes; they can keep filling past the cap. Fix: pull every quote minutes before `expiresAt`, warn the user before.
- A child missing from SoDEX's batch answer counts as placed (`sink.ts:133-147`): ghost "open" orders, reject counter
  reset, a grid level stuck forever. A cancel's per-row failures are ignored (`sink.ts:191-198`).
- No cancel-on-disconnect: a hard executor crash leaves quotes until restart (`runtime.ts:452-454`). Ask SoDEX; alert on
  crash loops while bots are live.

### A2. Positions left open without a loss limit
- Endings that skip the bot's own close setting: a bound with `then: 'stop'`, 25 refusals, the 4th SoDEX limit refusal,
  delisting all call `end()` directly (`runtime.ts:1270-1271, 3054, 3158, 1209`). Route bot endings through `stopBot`.
- The close gives up after 3 ordinary post-only refusals and ends "nothing more to close" with the position open
  (`runtime.ts:1771-1772, 1738-1739`). Count only reduce-only refusals, or confirm flat with a read.
- Loss limit, end time and volume target are not checked while a bot is held (paused, brake, key, region, beta,
  SoDEX limit, no quote) (`runtime.ts:1213-1257`). The beta check is in memory and holds every real bot when server 1 does
  not answer for 10 min (`service.ts:1204, 1243`). Check limits on every step; keep the beta answer in the db.
- A clean stop never finishes under the brake (`runtime.ts:1218-1224, 2942-2946`): let reduce-only closes through, or say so.
- Loss limit is optional for real bots (`spec.ts:320`). Make it required when not practice.

### A3. More risk than the user signed for
- Holding cap and margin use `orderUsd`, but each quote is raised to SoDEX's minimum order (`bots.ts:151, 185`;
  `runtime.ts:1849, 1894, 2184`). Steady ($12) on a market with a ~$100 minimum holds ~4x the cap. The unwinding quote is
  raised too and is not reduce-only, so it can flip the position. Fix: cap/margin on the real quote size; refuse a spec
  whose cap is below one minimum quote; unwinding quote reduce-only and capped at what it holds.
- A refused leverage/margin-mode change is logged and orders go out anyway (`runtime.ts:2957-2963`): the bot trades at
  the account's 20x. Hold opening orders until leverage is confirmed.
- Margin check gaps (`service.ts:1335-1351, 1401-1405`): unreadable equity lets the start through; a signed size update
  skips the check; the EEA 2x ceiling is not in `botMarginUsd`; starting a copy never counts bots' margin.
- "One live bot per market" ignores copies, other algos and manual positions on that market, while the bot's inventory,
  cap and close come from its own fills only (`service.ts:1313-1316`; `runtime.ts:1695-1699, 1733-1771`).
- Two-sided batches are checked as one side in `fitLimits` and the leverage ceiling (`runtime.ts:3070-3073, 2968`).
- Takeover restart can miss the old bot's late fills (`runtime.ts:1449-1450, 1537`); grid partial fills lose their
  counterpart (`runtime.ts:3717`).

### A4. The web signs a different spec than the screen shows
- Grid "Run for" never stops: `endAt` not sent for grids (`apps/web/src/bots/presets.ts:283`).
- Any restart drops the end time: `draftOfSpec` never reads `endAt` back (`presets.ts:319-337`).
- Spread limit (default 20 bp) and trading hours are shown as on but not sent for grids and the book maker
  (`presets.ts:280-283`; `BotSettings.tsx:282`).
- Picking a preset rebuilds the draft and loses leverage, news, flow-gate settings, volume target, on-stop; `quietOnly`
  resets, so "trade only 14-16 UTC" becomes "skip 14-16 UTC" (`BotNewPage.tsx:423-428, 518-521, 533`).
- Leverage not clamped per market or region, not reset when the market changes, 20x allowed before the market max is
  known (`BotNewPage.tsx:433-437`; `BotSettings.tsx:63-74`).
- Multi-market start fails halfway: started bots stay, Start again duplicates them; sizes checked for the first market
  only (`BotNewPage.tsx:473-509`).
- Notes "goes out at SoDEX's minimum" are dropped; Review shows the smaller size (`BotNewPage.tsx:477`).

### A5. Users lose sight of / control over running bots (web)
- Token gone but `signedIn` stays true: list reads return `[]`, bot page "No such bot", no Sign-in button; running bots
  cannot be stopped until a reload (`copy/live.ts:224-225, 609-613`; `algo/executorAlgos.ts`).
- `setBase` keeps the old executor id, so session tokens are filed under the wrong executor: sign-in lost or loops
  (`copy/executor.ts:95-97, 147-167`). Introduced by today's per-executor token key.
- Stop from the menu can fail silently (update before cancel outside `run()`, terms gate) (`BotsPage.tsx:263-266`;
  `StopMenu.tsx:36`). Owner rule: users can always stop.
- An old read can undo a stop on screen; a second "Clean stop" then ends the bot with the position open
  (`useBots.ts:63-71, 122-126`; `runtime.ts:880-881`).
- One wallet's copies/state can show under another after a switch (`live.ts:228-240`).

### A6. VIP move (hold VIP back from the launch unless fixed)
- Timeout or partial import runs the same bots on both executors with one key (`service.ts:740-773, 805-812`).
- Not serialised with the wallet's other actions; a bot started during the move loses its key (`service.ts:680-712`).
- The key is sealed to an unpinned public key read over `/info` (`service.ts:732-738`).
- Leaving the page mid-move never switches the browser to VIP (`BotsVip.tsx:358-369`); the scene can trap the user
  (no close, executor job only in memory) (`BotsVip.tsx:159`).
- Promo detection by label (`apps/server/src/routes/builder.ts:139-141`).

### A7. Capacity
- No cap on live bots per executor/IP (only 20 algos per wallet, `apps/executor/src/config.ts:234`). Measured capacity
  ~10 bots with pushed fills per IP (2026-11-05). Add a hard cap.

---

## B. Before launch: wrong or misleading numbers

- **Fees**: every estimate uses the old flat 0.1 bp (`info.bots.fee`, `BotsPage.tsx:214`; server `botMarkets.ts:124`)
  while the executor charges the ladder 0.5 / 0.4 / 0.3 / 0.2 / 0.1 bp. Bot page hint hardcoded "0.1 bp"
  (`BotDetail.tsx:228`). Booked fees use the market's base maker rate, not the user's tier (`runtime.ts:3318-3322`).
- **Practice and real summed** in the Fleet cards and chart (`fleet.ts:84-146`); folded runs mix practice and real
  (`fleet.ts:58`); folded tile sparkline and click are the newest run only.
- **Stopped bots**: a "keep" stop's PnL keeps moving with the mark while Holding shows 0 (`runtime.ts:1127-1140`);
  a manual stop drops its last up-to-5 minutes from the series (`runtime.ts:4230`).
- **Margin**: receipt "Sets aside" ≠ the start check (ladder levels, `BotNewPage.tsx:333` vs `bots.ts:383`); New bot's
  "free" is stricter than the executor's (own positions, browser copies) (`Allocation.tsx:65-77`); leverage hint says
  "as your account holds it" while margin counts 1x (`BotSettings.tsx:65-71`).
- "Running" includes paused (`fleet.ts:89`); Holding nets longs and shorts (`fleet.ts:96`); Savings pace counts stopped
  bots by `now - start` (`BotsSavings.tsx:35-37, 77`); two different "Estimate" figures on one bot page
  (`BotDetail.tsx:204, 259`); "Paid so far" includes the open position.
- Fleet windows go empty for 1H/6H on long histories and count up to one step before the window (`fleet.ts:115-118`).
- Bot log loses events after a hidden tab or a burst (newest-N paging) and never starts on an empty first page
  (`useBots.ts:187-205`; `apps/executor/src/db.ts:447`).
- Beta 30-day VIP: server counts from listing, executor from first bot (practice included) (`service.ts:1175-1181`).
- Shared "moved in X s" includes the signature wait and display pacing (`BotsVip.tsx:62, 161`).
- Max holding drifts while typing the order size (`BotSettings.tsx:157-158`); HoursGate rounds UTC+5:30 to +6.
- Explore: activity is SoDEX's, the rest from the recorder (now gap-aware, 50169075).

## B. Before launch: what users cannot do or are not told

- Any settings change forces a restart (a Clean restart closes the position), even a rename or loss limit; the executor
  already updates in place (`BotDetail.tsx:73-104`).
- Practice bot cannot become real; a stopped bot cannot be run again (`BotDetail.tsx:77, 87`).
- Stop all always keeps positions (`BotsPage.tsx:288`).
- Bot alerts: title says "Volume maker buy on …" (`packages/copy-engine/src/notices.ts:45-49`) and reach the bell only.
  Add email/Telegram/push for failed, loss limit and closed-outside.
- No warning before the trading key expires.
- Refusal messages name copy-trading steps, "algo orders", beta.valuedesk.so on the main site, no Deposit button
  (`service.ts:1311, 1320, 1330, 1332`; `BotNewPage.tsx:625-628`). Map codes to a sentence and a button.
- Markets where the user already runs a real bot are not marked; size errors appear only at Review; Start disabled with
  no reason (`BotNewPage.tsx:624, 644`).
- Holding without long/short, entry, liquidation price; PnL not split into closed/open.
- Non-beta wallets cannot even look (Explore, practice locked) (`BotsPage.tsx:124-149`); refused screen on beta has no
  Discord link (`beta/BetaGate.tsx:201`).

## C. Soon after launch

- Practice vs real as its own wizard choice; all four setup steps listed; tile Stop vs menu Stop the same.
- Glossary for bp, oracle, touch, tick, skew, informed flow, IOC, post-only; help text for Run for, Stop after, On stop,
  Out of range; "stops after about $X traded" next to the loss limit.
- Deleted view and restore; CSV export of fills; copy a log row.
- Phone: sticky Back/Next/Start bar.
- Paper fills optimistic (no queue, prints not consumed) (`runtime.ts:4138-4143`): practice looks better than live.
- Quote max age 15 s (`feed.ts:92`): 2-3 s for bots.
- Duplicated figures (Fleet panel vs chart; Performance row vs tiles); no leverage / gates / limits in the bot header;
  no progress toward loss limit, run end, volume target.
- Low: `countTaker` credits ended bots; MM late rejects not backed off; Enter on a row button also opens the bot;
  malformed `/bots/%E0` URL throws; dev proxy hangs; memory maps never shrink; GIF/share fine.
- Docs: `docs/BOTS.md` fee and live-gate text stale; `BotForm.tsx` dead (387 lines).

## Tests missing for A

Key missing / cancel throws on stop; failure endings with close on; close after post-only refusals; limits while held;
minimum-size quote over the cap; failed setLeverage; readBatch whole-batch error; one-bot-per-market and margin refusals
(update, copies, unreadable equity, EEA); VIP move and import (timeout, partial, retry, races); token loss on the web.
