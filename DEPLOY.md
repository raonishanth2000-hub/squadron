# Getting Squadron live

The site is a stateful server, not a static site: a SQLite database and the
attachment bytes live under `data/`, and the WebSocket connection carries chat,
DMs, typing and the WebRTC signalling for meetings. So it needs an always-on
container with a mounted disk — which is also why Vercel cannot host it.

Everything in this repo is already prepared. What is left needs an account, and
only you can create that.

## Why the browser says "not secure"

Two different addresses, two different certificates:

| Address | Certificate | Browser |
|---|---|---|
| the tunnel URL in `data/public-url` | Google Trust Services, real | padlock, no warning |
| `https://10.69.1.5:4173` (LAN) | self-signed `squadron.local` | **"Not secure"** |
| `https://localhost:4173` | self-signed `squadron.local` | **"Not secure"** |

Send people the tunnel URL, never the LAN one. A self-signed certificate cannot
be made trusted — that is the whole point of it.

## Deploying (Railway)

1. Create the account at railway.app and add a card.
2. `npm i -g @railway/cli && railway login`
3. From this directory: `railway init` then `railway up`
4. In the project's Variables, set:
   - `SQUADRON_HTTP=1`  (Railway terminates TLS at its edge and forwards http)
   - `PUBLIC_URL=https://<your-app>.up.railway.app`
5. In Settings → Volumes, mount a volume at **`/app/data`**.
   Skip this and every deploy wipes the database and all attachments.
6. Generate a domain in Settings → Networking. That URL is permanent and has a
   real certificate, so camera and microphone work and the link stops changing.

Fly.io works the same way (`fly launch`, `fly volumes create`). Avoid Render's
free tier: it sleeps after inactivity, which drops every WebSocket, and its
persistent disks are paid anyway.

## Moving your existing data

`data/squadron.db` is one file, but it is in WAL mode, so copy it checkpointed
rather than grabbing the file mid-write:

    sqlite3 data/squadron.db "PRAGMA wal_checkpoint(TRUNCATE);"

Then upload `data/squadron.db` and the whole `data/files/` directory into the
mounted volume. **Never delete `squadron.db-wal` on a live database** — that is
how a previous copy of this project lost its accounts and messages.

## What does not survive the move

The compiler. `server/run.js` sandboxes execution with macOS `sandbox-exec`,
which does not exist on Linux, and it is written to refuse rather than run
unprotected — so the deployment is safe, the compiler is just switched off and
says so. Restoring it means porting the seatbelt profile to `bubblewrap`
(`--unshare-net`, a read-only toolchain bind, tmpfs scratch, plus the rlimits
and kill-timer already in the file). Everything else — channels, DMs, files,
whiteboard, tasks, meetings — works unchanged.
