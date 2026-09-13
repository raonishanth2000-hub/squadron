#!/bin/sh
# Starts a Cloudflare quick tunnel and records the hostname it hands out.
#
# The hostname changes on every restart, so the server cannot read it from a
# fixed env var. It is written to data/public-url, which the server reads per
# request when building invite and meeting links. Without it those links fall
# back to the LAN address, which is plain http — and browsers refuse camera and
# microphone access on a non-secure origin.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/.tmp/tunnel.log"
mkdir -p "$ROOT/.tmp" "$ROOT/data"

# Find the server instead of assuming where it is. `npm start` listens on 4173
# over https, `npm run dev:http` on 4173 plain, and PORT moves either of them —
# so a tunnel with a hardcoded port silently points at nothing, which looks
# exactly like "the site is down" to everyone you sent the link to.
ORIGIN=""
for p in ${PORT:-4173} 4173 3000; do
  if curl -s -o /dev/null --max-time 3 "http://localhost:$p/"; then
    ORIGIN="http://localhost:$p"; EXTRA=""; break
  fi
  if curl -sk -o /dev/null --max-time 3 "https://localhost:$p/"; then
    # the dev certificate is self-signed, so the tunnel has to be told not to verify it
    ORIGIN="https://localhost:$p"; EXTRA="--no-tls-verify"; break
  fi
done

if [ -z "$ORIGIN" ]; then
  echo "no Squadron server is answering on 4173 or 3000."
  echo "start one first:  npm start      (https, camera and mic work)"
  echo "             or:  npm run dev:http"
  exit 1
fi

# cloudflared writes api.trycloudflare.com into its own info and error lines, so
# a bare grep for a trycloudflare host picks that up and publishes it as the
# public address. Only the assigned hostname matters, and it is never "api".
read_hostname() {
  grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null \
    | grep -v '://api\.' | head -1
}

# Replace the running cloudflared with a fresh one and wait for its hostname.
# PID is always left pointing at a live process, because the watchdog loop
# below tests it to decide whether to keep going.
relaunch() {
  kill $PID 2>/dev/null
  wait $PID 2>/dev/null
  cloudflared tunnel --url "$ORIGIN" $EXTRA > "$LOG" 2>&1 &
  PID=$!
  await_hostname
}

# Wait for cloudflared to be handed a hostname. Creating a quick tunnel is a
# network call that can simply time out, so a failure here is not fatal.
await_hostname() {
  i=0
  while [ $i -lt 30 ]; do
    sleep 2
    URL=$(read_hostname) || true
    [ -n "$URL" ] && return 0
    i=$((i+1))
  done
  URL=""
  return 1
}

printf 'found the server at %s\n' "$ORIGIN"
printf 'starting a tunnel …\n'
cloudflared tunnel --url "$ORIGIN" $EXTRA > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -f "$ROOT/data/public-url"; echo; echo "tunnel closed - invite links fall back to the LAN address"; exit 0' INT TERM

if ! await_hostname; then
  echo "cloudflared never got a hostname - see $LOG"
  kill $PID 2>/dev/null
  exit 1
fi

printf '%s' "$URL" > "$ROOT/data/public-url"
echo
echo "  $URL"
echo "  https, so camera, microphone and screen share work for everyone you send it to."
echo "  Ctrl+C closes it."
echo

# A quick tunnel can be revoked at the Cloudflare end while cloudflared keeps
# running, retrying a hostname that no longer exists. That failed silently: the
# process looked healthy, data/public-url still held the dead hostname, and
# every invite link pointed at nothing. So watch the tunnel from outside, the
# way a visitor sees it, rather than trusting the process to still be alive.
#
# data/public-url is cleared the moment it stops answering. The server reads
# that file per request, so links stop claiming to work before a new tunnel is
# up, and NEW links pick up the new hostname on their own once it is. Links
# already sent to people cannot survive a hostname change — only a named tunnel
# on a Cloudflare account fixes that.
while kill -0 $PID 2>/dev/null; do
  sleep 60
  kill -0 $PID 2>/dev/null || break
  if curl -s -o /dev/null --max-time 20 "$URL/"; then continue; fi
  sleep 10                                  # one blip is not an outage
  if curl -s -o /dev/null --max-time 20 "$URL/"; then continue; fi

  echo "  ! the tunnel stopped answering - opening a new one"
  rm -f "$ROOT/data/public-url"

  # Keep trying rather than giving up: asking Cloudflare for a quick tunnel is
  # a network call, and it times out often enough that one failure must not
  # leave the workspace with no public address at all.
  until relaunch; do
    echo "  ! could not reach Cloudflare - trying again in 30s"
    sleep 30
  done

  printf '%s' "$URL" > "$ROOT/data/public-url"
  echo
  echo "  new address: $URL"
  echo "  the old one is dead - send this to anyone who needs it."
  echo
done
