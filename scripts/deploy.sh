#!/bin/sh
# Push the local working copy to the live server.
#
# The data directory is excluded on purpose and lives outside the code tree on
# the server (/opt/squadron/data), so a deploy can never overwrite the database
# or the attachments — the mistake that quietly ends most self-hosted projects.
set -e
HOST=${SQUADRON_HOST:-root@63.250.41.127}
DOMAIN=${SQUADRON_DOMAIN:-squadron.nishanthrao.com}
KEY=${SQUADRON_KEY:-$HOME/.ssh/squadron_deploy}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ backing up the live database first"
ssh -i "$KEY" "$HOST" '/usr/local/bin/squadron-backup'

echo "→ pushing code"
rsync -az --delete \
  --exclude data --exclude .tmp --exclude node_modules --exclude .git --exclude .claude \
  -e "ssh -i $KEY" "$ROOT/" "$HOST:/opt/squadron/app/"

echo "→ installing dependencies and restarting"
ssh -i "$KEY" "$HOST" 'set -e
  chown -R squadron:squadron /opt/squadron/app
  cd /opt/squadron/app && sudo -u squadron npm ci --omit=dev --silent 2>/dev/null || sudo -u squadron npm install --omit=dev --silent
  systemctl restart squadron
  sleep 3
  systemctl is-active --quiet squadron && echo "  service is up" || { echo "  FAILED — recent log:"; journalctl -u squadron -n 20 --no-pager; exit 1; }'

echo "→ checking the site answers"
# Pin the lookup to the server we just deployed to. A stale entry in whatever
# resolver this machine happens to use would otherwise report a failure that
# has nothing to do with the deploy.
IP=${HOST#*@}
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 \
  --resolve "$DOMAIN:443:$IP" "https://$DOMAIN/" || true)
echo "  https://$DOMAIN -> $code"
[ "$code" = "200" ] || { echo "  site did not return 200"; exit 1; }

# and report what public DNS says, separately, since that is a different question
pub=$(dig +short @1.1.1.1 "$DOMAIN" A 2>/dev/null | head -1)
[ "$pub" = "$IP" ] && echo "  public DNS agrees: $pub" \
                   || echo "  note: public DNS says '${pub:-nothing}', expected $IP"
echo "✓ deployed"
