# Incident runbook

What to do when something goes wrong with real money on ValueDesk. Written to be followed at 3 a.m. from a
phone-sized brain: the first section is all most incidents need.

Servers: **server 1** `almalinux@161.97.154.121` (France: API, indexer; what the site reads) and **server 2**
`almalinux@13.140.77.201` (Tokyo: the copy and algo executor). SSH key `~/.ssh/valuescan-contabo`.
Alerts arrive on Telegram (deploy/server/bin/healthcheck.mjs, the cross-server watch and the GitHub watcher).

## The first five minutes

1. **Is money moving the wrong way?** Wrong orders, orders that should not exist, copies opening when the
   leader did not, an algo overfilling, fees off: **brake first, investigate second.**

   ```bash
   bash deploy/release/brake.sh on "We are looking into a problem with orders. Your positions and stops are untouched."
   ```

   That stops, within a second on the executor and within 30 s in every open browser tab: every order from
   the site, every copy order, every live algo (held, not cancelled). Stops already resting on SoDEX stay, so
   positions keep their protection. Followers can still pause, stop, stop-and-close and cancel.
   Narrower: `brake.sh on copies,algos "..."` (the site keeps trading), `brake.sh on trading "..."`.

2. **Check it took:**

   ```bash
   bash deploy/release/brake.sh status
   ```

   ```bash
   curl --limit-rate 2M -s https://www.valuedesk.so/api/health
   ```

   The health answer shows `"brake": {...}`. The site shows a yellow line at the top. On server 2,
   `journalctl --namespace=pii -u valuescan-executor | grep "emergency brake"` shows it was read.

3. **Say so.** A short post where followers look (the feedback channel / Discord once it exists; the status
   page shows the outage by itself). What is paused, that positions and stops are untouched, when the next
   update comes. Nothing about causes until they are known.

4. **Write down the time** you braked (UTC). Everything after is compared against it.

## Investigating

Everything the executor did is in its audit log (append-only, hash-chained, never pruned):

```bash
ssh -i ~/.ssh/valuescan-contabo almalinux@13.140.77.201
cd /opt/valuescan/current/apps/executor
sudo -u valuescan-executor /opt/node/current/bin/node --disable-warning=ExperimentalWarning --import tsx \
  tools/audit.ts since 2026-10-27T10:00Z
```

(It opens the database read-only, next to the running executor; `--db <path>` points it elsewhere, e.g. at
a restored backup.)

- `audit.ts wallet 0x...`: every request, order, stop, cancel and leverage change for one wallet, with
  SoDEX's answer to each.
- `audit.ts ref <copy id | algo id>`: one copy or one algo.
- `audit.ts kind order --json | jq ...`: every order.
- `audit.ts verify`: the chain holds (no row changed or removed). Compare its head with the last
  `audit head` line in `journalctl --namespace=pii -u valuescan-executor`.

Also: the copy activity log and algo events (what followers see, kept a year), `journalctl -u
valuescan-executor` / `-u valuescan-api` / `-u valuescan-indexer` (kept a year), SoDEX's own order history
for the account (the truth about fills), and the consents table (every signed instruction of every wallet).

## Common incidents

| What | First move | Then |
|---|---|---|
| Wrong or unexpected orders | Brake (all) | Audit log for the wallet/copy/algo; find the code path; fix, test, release; lift the brake; tell affected followers what happened to their account. |
| Executor down (Telegram: executor health) | `ssh` server 2, `systemctl status valuescan-executor`, `journalctl --namespace=pii -u valuescan-executor -n 200` | It restarts itself; a crash loop means the last release: `deploy/release/rollback.sh --executor-only`. Copies catch up on restart without doubling orders; algos resume their schedule. |
| API / site data down | `systemctl status valuescan-api valuescan-indexer caddy` on server 1 | Rollback with `--api-only` if a release caused it. Trading through SoDEX still works from sodex.com; say so. |
| SoDEX down or degraded | Nothing to fix here. The maintenance banner shows SoDEX's own status. | Consider `brake.sh on copies,algos` so nothing fires into a broken book when it comes back; lift once SoDEX trades normally. |
| A server compromised (or suspected) | Brake (all), then stop the executor: `sudo systemctl stop valuescan-executor` | Rotate every secret that box held: `deploy/release/rotate.sh list`, each with a plan first (docs/deploy/SECRETS.md, "After a leak"). The executor's `kek` protects followers' sealed keys: if the box is compromised assume they are exposed - followers must revoke the ValueDesk key on SoDEX (copy setup shows how) and register a new one. Rebuild from git on a fresh box; restore the database from the off-server backup. |
| Disk full | `df -h`; `journalctl --vacuum-size=...` only as a last resort | The health check warns before it is full. Grow the disk or prune the index. |
| A sanctioned wallet slipped through | Stop its copies/algos (they are held already when the list matches) | Update the list (`packages/copy-engine` sanctions list and its update script), release, document. |
| Fee or builder charge wrong | No brake needed unless it is still happening | Builder ledger on server 1 (`builder.db`), the fee ladder, the audit log's `builder` field per order. Refund via the builder account if owed. |
| Vercel down | Nothing on our side | The API and executor keep running; followers' copies and algos keep trading on the executor. |

## Lifting the brake

Only once the cause is fixed (or known not to recur) and the fix is released:

```bash
bash deploy/release/brake.sh off
```

Copies go on from their leader's **next** trade - what the leader did while braked is not copied after the
fact, so a follower can be out of line with the leader until then (tell them; they can stop-and-close and
start again). Held algos go on by themselves. Watch the next few minutes of the audit log.

## Afterwards

- A short write-up (docs/incidents/YYYY-MM-DD-name.md): timeline in UTC, what was affected (wallets,
  amounts), cause, fix, what changes so it cannot recur.
- If followers lost money because of us: work out each one's loss from the audit log and SoDEX's history,
  and decide on compensation. Legal duties (data breach notification within 72 h under GDPR Art. 33, if
  personal data was exposed) apply from the moment we know.
- Add a test that would have caught it.
