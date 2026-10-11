#!/usr/bin/env bash
# Deploy Copas to Monad testnet and wire the result into the other packages.
# Needs contracts/.env: DEPLOYER_KEY, PERPL_EXCHANGE, PERP_IDS, IDENTITY_8004 (see .env.example).
# Simulated OK on 11 Oct 2026: ~14.3M gas, up to ~2.91 MON (Monad charges the gas limit).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
RPC="${MONAD_TESTNET_RPC_URL:-https://testnet-rpc.monad.xyz}"
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")

bal=$(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)
echo "deployer $DEPLOYER balance $bal MON"
python -c "import sys; sys.exit(0 if float('$bal') >= 2.95 else 1)" || { echo "need >= 2.95 MON"; exit 1; }

forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast --slow
dep=deployments/10143.json
cat "$dep"

# Indexer: Copas addresses + start at the deploy block (LeaderBook/FollowerVault/UnderwriterPool are discovered).
idx=../indexer/.env
get() { python -c "import json;print(json.load(open('$dep'))['$1'])"; }
for kv in "REGISTRY:registry" "BREACH_MARKET:breachMarket" "AGENT_REGISTRY:agentRegistry"; do
  var="ENVIO_COPAS_${kv%%:*}_10143"; val=$(get "${kv##*:}")
  grep -q "^$var=" "$idx" && sed -i "s|^$var=.*|$var=$val|" "$idx" || echo "$var=$val" >> "$idx"
done
echo "indexer .env updated (restart the indexer; config start block must be <= $(get block))"

(cd ../plugin && node scripts/sync-contracts.mjs)
(cd ../web && node scripts/sync-contracts.mjs)
echo "done: web, keeper (CHAIN_ID=10143 default) and plugin read $dep"
