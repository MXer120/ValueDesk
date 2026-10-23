# ValueDesk copier (the copy executor)

The program that copies a trader for you: it watches the trader's public
trades on SoDEX or Hyperliquid and places the copies, under your rules, on
SoDEX perps in your own account, with a key you registered there.

The same code runs in two places:

| | Hosted | Self-hosted |
|---|---|---|
| Who runs it | ValueDesk, on its server in Tokyo (AWS ap-northeast-1) | You: your computer, or a server you rent |
| Where your copy key lives | encrypted on ValueDesk's server | in `copier-data/` on your machine, encrypted |
| Who places the orders | the hosted executor, 24/7 | your copier, while it runs |
| Fee | the copy fee on each copied order | the copy fee on each copied order (the builder id is a setting: `EXECUTOR_BUILDER_ID`) |

A third mode needs no executor at all: **This browser** in ValueDesk's copy
setup runs the same engine inside your open browser tab.

Everything is MIT-licensed (`LICENSE`). The engine is `packages/copy-engine`,
the signing library `packages/sodex-core`.

## Run it yourself

You need Node.js 22 or newer.

```bash
# Download the single-file build and check it
curl -O https://valuedeskapp.vercel.app/copier/valuedesk-copier.mjs
curl -O https://valuedeskapp.vercel.app/copier/valuedesk-copier.mjs.sha256
sha256sum -c valuedesk-copier.mjs.sha256

node valuedesk-copier.mjs
```

It prints its address (`http://127.0.0.1:8799`) and a **pairing code**. In
ValueDesk, open Copy, press **Set up copy trading**, choose **Self-hosted**,
enter the address and the code. The first wallet that signs in with the code
is the only wallet this copier ever serves (or set `EXECUTOR_OWNER=0x...` to
name it up front). Then, in the same sheet, register the copier's key on
SoDEX with your wallet and start copying. The copier must keep running for
copies to happen.

From the repository instead: `cd apps/executor && npm start`.

With Docker (from the repository root):

```bash
docker build -t valuedesk-copier -f apps/executor/Dockerfile .
docker run -d --name copier -p 127.0.0.1:8799:8799 -v copier-data:/data valuedesk-copier
docker logs copier
```

### On a server

The copier speaks plain HTTP and listens on loopback. Keep it that way and
reach it through an SSH tunnel when you set it up from your browser:

```bash
ssh -N -L 8799:127.0.0.1:8799 you@your-server
```

then use `http://127.0.0.1:8799` in ValueDesk as above. Once your copies are
set up, the tunnel can be closed: the copier keeps running on the server.

## Settings

| Variable | Default | |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8799` | where it listens |
| `EXECUTOR_DATA_DIR` | `./copier-data` | database, the key-encryption key, the session secret: back this folder up, keep it private |
| `EXECUTOR_OWNER` | (paired) | the one wallet it serves |
| `SODEX_NETWORK` | `mainnet` | or `testnet` |
| `EXECUTOR_BUILDER_ID` | `221909` | the builder copied orders carry; `0` for none |
| `EXECUTOR_KEY_TTL_DAYS` | `90` | the longest key lifetime you may register |
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
