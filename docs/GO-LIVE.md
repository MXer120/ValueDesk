# Go-live checklist

What the owner asked to be in place before ValueDesk goes live to the public, and how
each item is checked. The infrastructure side (servers, headers, backups, alerts) is
`docs/deploy/DEPLOY.md` section 11; that list points here.

Status: 2026-10-27. An item is ticked only when it holds on the production site.

## 1. Send feedback

> "Build a send feedback button which will in the future open a discord link. Ensure
> we don't go live without this being done." (owner, 2026-10-27) - extended the same day:
> a chat with replies in the bell, screenshots, right-click, Help & FAQ in Settings.

- [x] Every page shows **Send feedback** in the workspace bar at the bottom
      (`apps/web/src/feedback/FeedbackButton.tsx`, rendered by
      `components/StatusFooter.tsx`). **Guarded by a test:**
      `apps/web/src/feedback/feedback.test.tsx` fails if the bar stops rendering the
      entry, or the shell stops rendering the bar or the feedback host.
- [x] Also from Settings - Help & FAQ (`feedback/HelpSection.tsx`, with the FAQ) and from
      a right-click anywhere ("Send feedback about this", `feedback/FeedbackMenu.tsx`; the
      dashboard's own menu has it too), which attaches the clicked element.
- [x] One ongoing chat per visitor, never closed (owner, 2026-10-27: "a permanent chat").
      The chat is always the connected wallet's (owner, 2026-10-28). Sending needs no
      signature; every message carries the connected wallet's address, marked "proven" in
      Telegram (and in the chat) only when sent signed in. Reading the chat, its
      screenshots and replies needs the wallet's free signature (`feedback/session.ts`,
      `ops/feedbackAuth.ts`, a 30-day session) - nothing else opens it, and without it
      nothing about the chat is told, not even a reply count: the bell then only shows a
      fixed "sign in to see replies" row left at send time. Without a wallet a message
      still goes, and the form says replies need a wallet. A browser token
      (`feedback/threads.ts`, hash only on the server) reads and counts nothing; at the
      first sign-in it moves what that browser sent without a wallet (and chats from
      before) into the wallet's chat. Kind (Bug, Idea, Other) and Areas (a multi-select with
      search, `feedback/AreaPicker.tsx`, `ops/feedbackAreas.ts`; required for a bug). Send
      opens a second window with the red warning and a slide to confirm. Limits per
      address and per chat. Stored in `feedback.db` and `feedback-images/` in the data
      directory, both in the off-server backup (`backup-offsite.sh`, set api-state). Messages and up
      to three screenshots (re-encoded in the browser, checked by their bytes on the server,
      `ops/imageCheck.ts`) go to the owner by Telegram, one reply chain per thread. The
      owner **replies in Telegram to the bot's message**; the API reads replies by long
      polling (`ops/telegramReplies.ts`), and the visitor gets them in the bell and as a
      toast (`feedback/FeedbackHost.tsx`, every minute while the tab is visible).
- [x] Page and browser info on by default ("Recommended"), every line shown before
      sending. A private key or a seed phrase
      in the text is refused, in the browser and on the server (`ops/secrets.ts`).
- [ ] **The Vercel function** (`deploy/vercel/api-proxy.cjs`) must let through: `POST`
      with `Content-Type` and `Authorization` for `/api/vs/feedback`,
      `/api/vs/feedback/upload` (body up to 2,113,536 bytes), `/api/vs/feedback/thread`,
      `/api/vs/feedback/poll`, `/api/vs/feedback/session` (16 KB each; already covered by
      the proxy's `/api/vs/feedback/` prefix), `GET` with `Authorization` for
      `/api/vs/feedback/image` (answer up to 2 MiB, image/*), and `POST` with
      `Content-Type` for `/api/vs/client-errors` (8 KB); never cached. Check: send a message
      with a screenshot from the live site, reply in Telegram, see the reply in the bell.
- [ ] Telegram: `ALERT_TELEGRAM_TOKEN` (the bot's token from @BotFather) and
      `ALERT_TELEGRAM_CHAT_ID` (the owner's chat with the bot) in the API's secret env on
      server 1. The bot must have no webhook set (getUpdates is refused while one is), and
      no other process may poll the same bot (local dev polls only with
      `VALUESCAN_FEEDBACK_REPLIES=1`).
- [x] **The Discord link** (https://discord.gg/TVJKHY9vhK, 2026-10-28): `VITE_FEEDBACK_URL` set to the
      invite (https) in `deploy/vercel/production.settings`, and add the name to
      `VITE_VARS` in `deploy/release/build-web.sh` and to `deploy/release/web.env.example`
      (the build refuses a `VITE_*` name it does not control). Until then the form's
      Discord button says "coming soon".

## 2. Client error reports

> "yup we need that" (owner, 2026-10-27)

- [x] A production build reports uncaught errors, unhandled rejections and crashes the
      error boundaries catch (`apps/web/src/errorReport.ts`) to
      `POST /api/vs/client-errors`: scrubbed (`apps/server/src/ops/scrub.ts`, the same
      code on both sides), one entry per fingerprint, batched, at most 30 entries a
      browser session, sampled once a page throws more than 10 new errors a minute.
- [x] The server counts them per fingerprint in `client-errors.db` (at most 5000 rows)
      and tells the owner of a NEW fingerprint by Telegram, at most 20 a day.
- [x] The owner's view: `npx tsx tools/client-errors.ts top` in `apps/server` on
      server 1 (`show <fingerprint>`, `clear <fingerprint>`).
- [x] The privacy policy describes it (section 4, "Error reports and feedback").
- [ ] The privacy policy's placeholders for it are filled in: how long reports and
      feedback are kept, and Telegram as a recipient.
- [ ] The proxy change of item 1 is live (the same two paths).

## 3. Status page

> "want an uptime page at minimum for frontend and the executor where copy and algos
> run" (owner, 2026-10-27)

- [x] `https://www.valuedesk.so/status` - public, no wallet, no terms popup - shows the
      website, the data API, the copy & algo executor and the indexer: their state now and
      90 days of daily uptime bars (`apps/web/src/status/`). Linked from the workspace bar.
- [x] The API on server 1 probes every minute (`apps/server/src/ops/status.ts`) and
      answers `GET /api/vs/status` (cached 30 s, public). Minutes it did not probe show as
      no data.
- [x] If server 1 does not answer, the page says the status service is unreachable and
      asks `/api/copy/v1/health` from the browser itself.
- [ ] After the release, the page shows data for all four services (the first bars fill
      within a minute). Optional: `VALUESCAN_STATUS_EXECUTOR_URL=https://13-140-77-201.sslip.io`
      in the API's env to probe the executor on server 2 directly (with the origin secret)
      instead of through the site; without it the probe takes the visitor's path.
- [ ] An external monitor still watches the site (DEPLOY.md section 11): the status page
      cannot report its own server being down for the minutes nobody looks.
