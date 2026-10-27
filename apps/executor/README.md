# ValueDesk copier (the copy executor)

The program that copies a trader for you, and runs your algo orders (TWAP,
VWAP, DCA, iceberg, ...): it watches the market and the trader's public trades
on SoDEX or Hyperliquid and places the orders, under your rules, on SoDEX perps
in your own account, with a key you registered there.

The same code runs in two places:

| | Hosted | Self-hosted |
|---|---|---|
| Who runs it | ValueDesk, on its server in Japan | You: your computer, or a server you rent |
| Where your trading key lives | encrypted on ValueDesk's server | encrypted in the copier's data folder on your machine |
| Who places the orders | the hosted executor, 24/7 | your copier, while it runs |
| Fee | the copy fee on each order | the copy fee on each order (the builder id is a setting: `EXECUTOR_BUILDER_ID`) |

A third mode needs no executor at all: **This browser** in ValueDesk runs the
same engine inside your open browser tab.

Everything is MIT-licensed (`LICENSE`). The engine is `packages/copy-engine`,
the signing library `packages/sodex-core`.

## Run it yourself

You need **Node.js 22.13 or newer** (https://nodejs.org). `node --version` shows yours.

Download the single-file copier and check it is the one ValueDesk published:

```bash
# macOS / Linux
curl -O https://valuedesk.so/copier/valuedesk-copier.mjs
curl -O https://valuedesk.so/copier/valuedesk-copier.mjs.sha256
shasum -a 256 -c valuedesk-copier.mjs.sha256      # Linux: sha256sum -c ...
node valuedesk-copier.mjs
```

```powershell
# Windows (PowerShell)
curl.exe -O https://valuedesk.so/copier/valuedesk-copier.mjs
curl.exe -O https://valuedesk.so/copier/valuedesk-copier.mjs.sha256
(Get-FileHash valuedesk-copier.mjs -Algorithm SHA256).Hash.ToLower()   # compare with the .sha256 file
node valuedesk-copier.mjs
```

It prints its address (`http://127.0.0.1:8799`), a **pairing code** and the
folder it keeps its data in. In ValueDesk (https://valuedesk.so) open **Copy**,
press **Set up copy trading**, choose **Self-hosted**, and enter the address and
the code. The first wallet that signs in with the code is the only wallet this
copier ever serves (or set `EXECUTOR_OWNER=0x...` to name it up front). Then, in
the same sheet, register the copier's key on SoDEX with your wallet. Copies and
algo orders placed on it run while it runs: keep the window open.

Only one copier runs per data folder: a second one started on the same folder
refuses to start (it would place every order twice).

From the repository instead: `cd apps/executor && npm start`.

With Docker (from the repository root):

```bash
docker build -t valuedesk-copier -f apps/executor/Dockerfile .
docker run -d --name copier -p 127.0.0.1:8799:8799 -v copier-data:/data valuedesk-copier
docker logs copier            # the address and the pairing code
```

### On a server

The copier speaks plain HTTP and listens on loopback. Keep it that way and
reach it through an SSH tunnel when you set it up from your browser:

```bash
ssh -N -L 8799:127.0.0.1:8799 you@your-server
```

then use `http://127.0.0.1:8799` in ValueDesk as above. Once your copies are
set up, the tunnel can be closed: the copier keeps running on the server.

### Its data folder

The database, the key-encryption key and the session secret. Keep it private
and back it up: without it, the copier's key and its pairing are gone (register
a new key and pair again). By default:

- `./copier-data` if the folder you start it from already has one (copiers
  before 27 October 2026 kept it there);
- otherwise your own app-data folder: `%LOCALAPPDATA%\ValueDesk\copier` on
  Windows, `~/Library/Application Support/ValueDesk/copier` on macOS,
  `~/.local/share/ValueDesk/copier` on Linux.

`EXECUTOR_DATA_DIR` sets another.

## Settings

| Variable | Default | |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8799` | where it listens |
| `EXECUTOR_DATA_DIR` | see above | database, the key-encryption key, the session secret |
| `EXECUTOR_OWNER` | (paired) | the one wallet it serves |
| `SODEX_NETWORK` | `mainnet` | or `testnet` |
| `EXECUTOR_BUILDER_ID` | `221909` | the builder orders carry; `0` for none |
| `EXECUTOR_KEY_TTL_DAYS` | `90` | the longest key lifetime you may register (at most 90) |
| `EXECUTOR_LIVE_ALGOS` | off | `1` lets real (non-practice) algo orders start; practice runs always can |
| `EXECUTOR_ALLOWED_ORIGINS` | ValueDesk's site and `localhost:5180` | which web pages may call it |
| `LOG_LEVEL` | `info` | `debug` shows every request |

## What it does, exactly

- Reads every perps market's public trade stream on SoDEX (both parties are
  named by account id) and, for Hyperliquid traders, the trader's fills;
  re-reads the trader's positions every minute.
- For each change of the trader's position: the planner
  (`packages/copy-engine/src/planner.ts`) sizes your copy by notional,
  applies your caps (max position, max leverage, the 2x limit for EEA
  residents), and sends an IOC limit order within your slippage cap.
- Keeps SoDEX stop-loss / take-profit orders on each copied position when you
  set them, so they hold even when the copier is down.
- Never retries an order it is unsure about; the next account read settles it.
- Every instruction you give it is a message your wallet signed; it keeps
  them (`GET /api/copy/v1/consents`).

## Stop

- **Stop all** in ValueDesk stops every copy (optionally closing the copied
  positions).
- **Revoke the key** on SoDEX (copy setup, or sodex.com) and nothing can
  trade with it any more - the hard stop.
- Stopping the program stops copying; positions and the SoDEX stop orders stay.
