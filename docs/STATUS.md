# Copas — Status fitur

Legenda: ✅ selesai + teruji · 🟡 dikerjakan · ⏳ menunggu (key/deploy) · ⬜ belum

| # | Fitur | Status | Lokasi | Catatan |
|---|---|---|---|---|
| — | Spike: kontrak memegang akun Perpl & trading | ✅ | `contracts/test/fork/PerplSpike.t.sol` | Fork mainnet 3 Okt, tanpa ignOracle/whitelist |
| A1 | Bond + drawdown + slashing | ✅ | `LeaderBook.sol` | unit, fork, invariant |
| A2 | Mandat onchain (market, leverage, notional) | ✅ | `LeaderBook.trade/_checkpoint` | |
| A3 | Bond dinamis | ✅ | `LeaderBook.minBond/capacity` | kapasitas = kebalikan minBond |
| A4 | Unbonding period | ✅ | `LeaderBook.requestUnbond/rollEpoch` | |
| A5 | Fee di atas HWM + escrow slashable | ✅ | `FollowerVault._touchEpoch`, `LeaderBook.depositFee` | |
| A6 | Tier mandat | 🟡 | web `/become-leader` | |
| A7 | Atestasi rekam jejak | 🟡 | `services/` | |
| A8 | Leader AI agent ERC-8004 | ✅ kontrak · 🟡 keeper reputasi | `AgentLeaderRegistry.sol`, `keeper/` | |
| B1 | Underwriter pool | ✅ | `UnderwriterPool.sol` | |
| B2 | Token DOWN + Kuru | ✅ kontrak · 🟡 Kuru testnet | `BreachMarket.sol`, `onramp/scripts` | |
| B3 | Insured follow | ⬜ | | P3 |
| C1 | FollowerVault + sync copy-only | ✅ | `FollowerVault.sol` | fork mainnet: entry sama blok |
| C2 | Kontrol risiko follower | ✅ | `FollowerVault` | stop-loss, mask, leverage, chase, band |
| C3 | Backtest | 🟡 | `services/` | |
| C4 | Preview Tenderly | 🟡 | `services/` | |
| C5 | Portofolio leader | 🟡 | web (multi-vault) | |
| C6 | Auto-unfollow | 🟡 | keeper + kontrak (target 0 saat Unbonded/Breached) | |
| C7 | Bukti eksekusi | 🟡 | indexer + web | |
| C8 | Klaim slashing | ✅ | `FollowerVault.claim` | |
| D1 | Analis Kimi + signature | 🟡 | `services/` | |
| D2 | Nansen discovery + alignment | 🟡 | `services/` | |
| D3 | Agent penantang | 🟡 | `services/` | |
| D4 | x402 bayar data | 🟡 | `services/` | |
| E1 | Login Mera web | 🟡 | `web/lib/mera` | |
| E2 | Session Mera | 🟡 | web | |
| E3 | Feed strategi terenkripsi | ⬜ | web + API | Mera Many Keys |
| E4 | Identitas follower tak tertaut | ⬜ | web | |
| E5 | Vault kunci API | ⬜ | web | P3 |
| E6 | Privy server wallet + policy + sponsorship + DENY demo | 🟡 | `keeper/` | butuh key Privy |
| E7 | Blockaid | ⬜ | | P3, butuh key |
| F1 | Aurora deposit→follow | 🟡 | `onramp/` | butuh akses Intents Connect |
| F2 | Socket deposit address | 🟡 | `onramp/` | |
| F3 | Kuru Flow swap | 🟡 | `onramp/` | |
| G1 | Indexer Envio | 🟡 | `indexer/` | |
| G2 | Dashboard Perpl Analytics | 🟡 | `web/analytics` | |
| G3 | CRE workflow | 🟡 | `cre/` | |
| G4 | Alert Alchemy + Telegram | 🟡 | `keeper/` | |
| G5 | Halaman Proof | 🟡 | web | |
| G6 | Fuzz/invariant | ✅ | `contracts/test/CopasInvariant.t.sol` | 3 invariant |
| G7 | Portfolio BlockVision/Zerion | ⬜ | | P3 |
| H1 | Plugin MetaMask `mm copas` | 🟡 | `plugin/` | |
| H2 | Kartu profil shareable | ⬜ | web OG | |
| H3 | Liga musiman | ⬜ | indexer + web | |
| H4 | Referral | ✅ kontrak · 🟡 web | `FollowerVault.setReferrer` | |
| H5 | i18n ID/EN | 🟡 | web | |
| I1–I4 | Leader/follower nyata, model bisnis, update publik | ⏳ | — | setelah deploy mainnet |

Deploy: ✅ **testnet 10143** 11 Okt 2026, block 70102394 — registry `0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d`, alamat lengkap di `contracts/deployments/10143.json` (`contracts/deploy-testnet.sh`). Mainnet ⏳.
Demo seed: ✅ 12 Okt 2026 (`contracts/script/Seed.s.sol`) — leader `0x8478…2a18` book `0xda695cB060c7e2dF0b5c36EA591eA69399463D90` (deposit 100, bond 50, aktif, long 0,0002 BTC), follower vault `0x433fFb841c4Cc8521364aBf14BEab9a008DCe5a1` (deposit 100, ratio 50%, tersalin 0,0001 BTC). AUSD testnet: faucet `0xd236c18d274e54faccc3dd9dda4b27965a73ee6c` `requestFunds(address)` = 10k AUSD.
Breach demo: ✅ 12 Okt 2026 (`contracts/script/Breach.s.sol`) — leader book `0xb1B08F6a0642c51b48c1916136458A769a1c5208` breached epoch 2 (drawdown), bond 25 AUSD slashed ke pot, vault `0x38E8EbBD7Bd291036A0EFe4a6eFa3BCcd27D74ff` unwind lalu klaim kerugian riil 0,029936 AUSD dari pot.
