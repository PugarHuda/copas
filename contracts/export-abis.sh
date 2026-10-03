#!/usr/bin/env bash
# Rebuild and export contract ABIs to ../abis
set -e
cd "$(dirname "$0")"
forge build >/dev/null
for c in CopasRegistry LeaderBook FollowerVault UnderwriterPool BreachMarket BreachToken AgentLeaderRegistry; do
  python -c "import json;json.dump(json.load(open('out/$c.sol/$c.json'))['abi'],open('../abis/$c.json','w'),indent=1)"
done
cp abi/PerplExchange.json ../abis/
