# Putting ValueDesk online: what you do

The test site is live since 2026-10-03 at **https://valuedeskapp.vercel.app** - the
web app on Vercel, the index and the hosted copy executor on one small AWS server in
**Tokyo** (AWS ap-northeast-1). Until 2026-10-23 that server was in Frankfurt
(eu-central-1); the move is EC2-VERCEL.md, section 12 ("Moving to Tokyo"), and the
Frankfurt server is stopped, not deleted, afterwards - deleting it is your decision
(section 8 below). Claude runs the AWS and Vercel commands (the
list is `docs/deploy/EC2-VERCEL.md`, section 6). This page is only what needs
**you**: accounts, decisions, texts, and the checks at the end. Each step says when
it is needed.

---

### 1. Nothing to buy for now

There is no domain yet, on purpose: the site runs at `valuedeskapp.vercel.app`
(`valuedesk.vercel.app` belongs to someone else; the old `valuexplorer.vercel.app` still works).

Later, for your own name: buy it in Vercel (Domains -> Buy) and tell Claude - the
switch is described in EC2-VERCEL.md, section 8. Nothing on AWS has to be rebuilt.

### 2. Vercel plan - decide before the public launch

Vercel's free **Hobby** plan is for **non-commercial use only**. Testing with a few
people is fine on it. A launch that **charges a builder fee is commercial and needs
Vercel Pro** (20 USD a month per developer seat): vercel.com -> your team ->
Settings -> Billing -> Upgrade.

### 3. WalletConnect (so phone wallets can connect) - do this now

The test build uses the WalletConnect / Reown project id you already use for local
development (from `apps/web/.env.local`). Phone wallets connecting by QR code will
warn or refuse until the site's address is on that project's list:

1. Sign in at **https://dashboard.reown.com** and open that project.
2. In its **Domain / Allowlist** settings add exactly `https://valuedeskapp.vercel.app`
   (and `https://valuexplorer.vercel.app` while the old address is in use; later also your own domain). Do not add preview addresses: only this address
   talks to the index.
3. For the public launch you may want a separate project for production; give Claude
   its Project ID then (it is not a secret).

### 4. The builder account (only if a builder fee is to be charged)

You create it yourself; nobody else ever signs with your wallet.

1. Pick the wallet that should receive the fees - best a **dedicated** one that does
   not trade. On sodex.com (or in ValueDesk): **activate its SoDEX account** (a first
   deposit opens it) and hold **at least 100 vUSDC in Spot and at least 100 vUSDC in
   Perps** (deposit, then Transfer between the two), with a margin: below 100 in
   either, approvals fail. There is no separate registration.
2. Give Claude the wallet **address** (not a key). It checks it read-only
   (`node apps/web/tools/check-builder.mjs <address>`), which prints the **builder
   id** (the account's primary account id) and whether it is eligible
   (docs/BUILDER-CODES.md, section 4).
3. Decide the fees (in tenths of a basis point: 10 = 0.01 %): perps, spot, and the
   ceiling users approve. They go into `web.env` (`VITE_BUILDER_ID`,
   `VITE_BUILDER_FEE_PERPS`, `VITE_BUILDER_FEE_SPOT`, `VITE_BUILDER_MAX_FEE`).
   Whether and what to charge is a business and a legal decision.
4. Per-wallet fee tiers (optional): Claude runs `builderTiers.ts init --builder-id
   <id>` on the server (DEPLOY.md, section 16). It creates a signing key in
   `/var/lib/valuescan/state` on the server's data disk - never copied anywhere else,
   though the disk's snapshots contain it - and prints a **public key**, which goes
   into the web build as `VITE_BUILDER_TERMS_KEYS`. Then the site is built and
   published again.

Without these values the site works, and no fee is approved or charged.

### 5. The legal pages - fill in the placeholders

The pages exist: `/impressum`, `/privacy`, `/terms` (texts in
`apps/web/src/legal/`). Every `[[OWNER: ...]]` in them is yours to fill: name and
address, contact e-mail and phone, register and VAT number if any, the supervisory
authority if any, the retention periods, the excluded countries, the place of
jurisdiction, the date.

- Since the site runs on **Vercel** (not CloudFront), the privacy policy's section on
  visiting the website has to name **Vercel** (its CDN worldwide, the `/api` function
  in **Tokyo**, Vercel region `hnd1`) and **AWS** (the server, **ap-northeast-1,
  Tokyo**) as processors - both changed from Frankfurt (`fra1`, eu-central-1) on
  2026-10-23. The server is **outside the EU** now: the policy has to say that the
  data goes to Japan and on what basis (Japan has an EU adequacy decision; which basis
  applies is for the lawyer). DEPLOY.md section 12 lists everything the policy has to
  cover, including the builder-fee ledger, other people's public trading data in the
  index, WalletConnect, and what stays in the visitor's browser.
- **The hosted copy executor** (Copy -> Set up copy trading -> Hosted) runs on the same
  Tokyo server and keeps, per follower: the wallet address, every signed instruction
  (never changed, never deleted by the executor) with the country Vercel reported for
  that request, the copies and their activity (365 days by default), and the copy key
  the follower registered, encrypted. The country comes from Vercel's own lookup of
  the visitor's address. The policy has to cover this too (DEPLOY.md section 12).
- **Have them reviewed by a lawyer.** They are drafts.
- The test site may go out with the placeholders (the build only warns). A **public**
  launch is built with `--public`, and that build is refused while one is left.

### 6. Watch the site from outside (5 minutes, free)

AWS sends no alerts in this setup. Create a free uptime monitor (for example
UptimeRobot or Better Stack) for **https://valuedeskapp.vercel.app/api/health**,
checking every 5 minutes, alerting your e-mail. It should answer `"ok":true`.

### 7. The live test run - once the site is up

Before you show the site to anyone, run the guided test on your PC:

1. Double-click **`RUN-LIVE-TESTS.cmd`** in the repository folder (or run it in a
   terminal). It explains every step and asks for a key itself, with a hidden
   prompt - never paste a key anywhere else, and never give it to Claude.
2. Use a small wallet with an amount you can afford to lose to a mistake.
3. Then go through DEPLOY.md section 12 ("Public testing checklist") by hand in the
   browser: connect, reject one signature, enable trading, deposit, transfer,
   withdraw, a limit order and its cancel, a market order and its close - with the
   browser console open.
4. Send Claude the summary the run prints at the end.

### 8. Stop and start - to save money

| | What it means | Cost per month (ap-northeast-1, Tokyo) |
|---|---|---|
| **Running** | the server is on; everything works | about 44 USD (t4g.medium 31.54, disks 16 + 80 GiB 9.22, fixed address 3.65) + CPU above its baseline (estimated 6 to 18) + snapshots (estimated 3 to 9) |
| **Stopped** | the server is off; nothing is deleted. The site still loads; trading, Portfolio and Scan still work (they talk to the exchanges directly); the leaderboard, Explore and Copy pages say the index is unavailable, and **hosted copies stop** (a follower's SoDEX stop orders stay) | about 13 USD (the disks and the fixed address) + snapshots |
| **Frankfurt, stopped** (after the move, until you delete it) | the old server, off; it serves nothing | about 13 USD (disks 16 + 80 GiB 9.14, fixed address 3.65) + its snapshots (0.054 per GB-month) |
| Vercel | Hobby free (non-commercial), Pro 20 USD | |

The Tokyo prices are what Claude knows of AWS's ap-northeast-1 price list (t4g.medium
0.0432 USD an hour, gp3 0.096 per GB-month, snapshots 0.05 per GB-month); they were
not checked against the live list on 2026-10-23 - EC2-VERCEL.md section 4 says how.
Tokyo costs about 3.60 USD a month more than Frankfurt while running.

Ask Claude to **stop** (`deploy/aws/ec2/provision.sh stop`) or **start**
(`... start`) it. After a start the index catches up by itself within minutes; it
keeps a gap for the time it was off. Nothing is ever deleted by stopping - deleting
the whole setup is a separate, manual decision (EC2-VERCEL.md, section 10).

**The Frankfurt server after the move** keeps costing about 13 USD a month while it is
stopped (its disks, its fixed address, its snapshots). Deleting it is **your decision**,
made separately, once Tokyo has run well for a while: tell Claude, and it follows
EC2-VERCEL.md section 10 for Frankfurt only. Until then it is the way back.
