#!/usr/bin/env bash
# Runs real `mm copas` command handlers against Monad testnet (plugin/scripts/live.ts) and captures their output
# for the MetaMask bounty clip. Key: a fresh funded test key in video/out/captures/plugin-key.txt (ours, not a user).
set -u
cd "$(dirname "$0")/../plugin"
OUT=../video/out/captures/plugin.txt
: > "$OUT"
export COPAS_LIVE_KEY=$(cat ../video/out/captures/plugin-key.txt) COPAS_CHAIN_ID=10143 COPAS_MAX_WITHDRAW_PER_DAY=20 NO_COLOR=1
LB=0xda695cB060c7e2dF0b5c36EA591eA69399463D90
mm() {
  echo "\$ mm copas $*" >> "$OUT"
  node --no-warnings scripts/live.ts "$@" --chain-id 10143 >> "$OUT" 2>&1
  echo "" >> "$OUT"; sleep 3
}
mm leaders
mm leader $LB
mm vault --create
mm deposit 100
mm follow $LB --ratio 0.5
mm follow $LB --ratio 0.5 --max-notional 25 --max-leverage 2 --chase-bps 50 --band-bps 30 --stop-loss-bps 1000 --markets BTC --yes
mm sync BTC
mm status
mm tighten --max-leverage 3
mm tighten --max-leverage 1
mm withdraw 15
mm withdraw 10
mm claim $LB 1
cat "$OUT"
