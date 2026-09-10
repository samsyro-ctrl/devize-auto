#!/usr/bin/env bash
# deploy.sh — trimite public-server.js pe server cu o singura comanda (de pe laptop).
#   ./deploy.sh        -> push pe GitHub + git pull + npm install + repornire
#   ./deploy.sh env    -> in plus, copiaza si .env (cand ai schimbat secrete)
#
# Tipar copiat exact din licitatie-analiza/deploy.sh -- aceeasi conventie in
# toata familia asta de proiecte. Baza publica (output/public.db) NU e in git
# (vezi .gitignore) -- ramane pe server, un deploy n-o atinge.
set -euo pipefail

VPS="root@77.42.38.135"
KEY="$HOME/.ssh/hetzner"
DIR="/opt/devize-auto"
SERV="devize-auto"

echo "1/4  Push pe GitHub..."
git push origin main

echo "2/4  Server: git pull + npm install..."
ssh -i "$KEY" "$VPS" "cd $DIR && git pull --quiet origin main \
  && npm install --omit=dev --no-audit --no-fund --silent \
  && echo '   serverul e acum pe: '\$(git log -1 --oneline)"

if [ "${1:-}" = "env" ]; then
  echo "3/4  Copiez .env..."
  scp -i "$KEY" .env "$VPS:$DIR/.env"
  ssh -i "$KEY" "$VPS" "chmod 600 $DIR/.env"
else
  echo "3/4  (.env nemodificat — ruleaza './deploy.sh env' daca ai schimbat secrete)"
fi

echo "4/4  Repornesc serviciile..."
ssh -i "$KEY" "$VPS" "systemctl restart $SERV devize-auto-panou && sleep 2 \
  && systemctl is-active $SERV && systemctl is-active devize-auto-panou"

echo "✅ Gata — https://devize.buildandfix.ai (panoul intern: tunel SSH pe portul 7778)"
