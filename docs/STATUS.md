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
| A8 | Leader AI agent ERC-8004 | ✅ kontrak + testnet · 🟡 keeper reputasi | `AgentLeaderRegistry.sol`, `script/AgentLeader.s.sol` | agentId 2209 tertaut, agent trade lewat operator |
| B1 | Underwriter pool | ✅ + testnet | `UnderwriterPool.sol`, `script/Underwrite.s.sol` | 100 AUSD di pool leader demo |
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
| G1 | Indexer Envio | ✅ | `indexer/` | Envio Cloud, mainnet + testnet di head (72,5 jt event mainnet); testnet Perpl mulai blok 70.084.000 |
| G2 | Dashboard Perpl Analytics | ✅ | `web/analytics` | + heatmap funding & OI (MarketDaily), kohort trader (Account), likuiditas order book vs tekanan likuidasi (`/book`) |
| G3 | CRE workflow | 🟡 | `cre/` | |
| G4 | Alert Alchemy + Telegram | 🟡 | `keeper/` | |
| G5 | Halaman Proof | 🟡 | web | |
| G6 | Fuzz/invariant | ✅ | `contracts/test/CopasInvariant.t.sol` | 3 invariant |
| G7 | Portfolio BlockVision/Zerion | ⬜ | | P3 |
| H1 | Plugin MetaMask `mm copas` | ✅ testnet | `plugin/` | 13 command diuji live via `plugin/scripts/live.ts` (host CLI butuh `mm login`) |
| H2 | Kartu profil shareable | ⬜ | web OG | |
| H3 | Liga musiman | ⬜ | indexer + web | |
| H4 | Referral | ✅ kontrak · 🟡 web | `FollowerVault.setReferrer` | |
| H5 | i18n ID/EN | 🟡 | web | |
| I1–I4 | Leader/follower nyata, model bisnis, update publik | ⏳ | — | setelah deploy mainnet |

Deploy: ✅ **testnet 10143** 11 Okt 2026, block 70102394 — registry `0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d`, alamat lengkap di `contracts/deployments/10143.json` (`contracts/deploy-testnet.sh`). Mainnet ⏳.
Demo seed: ✅ 12 Okt 2026 (`contracts/script/Seed.s.sol`) — leader `0x8478…2a18` book `0xda695cB060c7e2dF0b5c36EA591eA69399463D90` (deposit 100, bond 50, aktif, long 0,0002 BTC), follower vault `0x433fFb841c4Cc8521364aBf14BEab9a008DCe5a1` (deposit 100, ratio 50%, tersalin 0,0001 BTC). AUSD testnet: faucet `0xd236c18d274e54faccc3dd9dda4b27965a73ee6c` `requestFunds(address)` = 10k AUSD.
Breach demo: ✅ 12 Okt 2026 (`contracts/script/Breach.s.sol`) — leader book `0xb1B08F6a0642c51b48c1916136458A769a1c5208` breached epoch 2 (drawdown), bond 25 AUSD slashed ke pot, vault `0x38E8EbBD7Bd291036A0EFe4a6eFa3BCcd27D74ff` unwind lalu klaim kerugian riil 0,029617 AUSD dari pot.

### Testnet 12 Okt 2026 (sore): fitur yang belum pernah jalan onchain

**Semua akun di bawah adalah akun uji milik kami sendiri** (key di `contracts/.env`), bukan pengguna. Jangan dihitung sebagai traksi.

- **Leader AI agent ERC-8004** ✅ (`contracts/script/AgentLeader.s.sol`, state `deployments/agent-10143.json`): identity registry testnet `0x8004A818…BD9e` (proxy, impl `0x7274e874…9c02`, EIP-712 `ERC8004IdentityRegistry` v1). Owner `0x2358787CEA19eC46202612a8949Cc185407fB8F1` mendaftar **agentId 2209**, tokenURI `data:application/json;base64` dengan name "Copas Momentum Agent"; agent key `0x32E6C5D4Bf1EDC86576769f794da3Dd41c140D52` menandatangani `AgentWalletSet` lalu jadi agent wallet. LeaderBook `0xbC277432C927996E5F91a2D356289895e1415958` (15% DD, 5x, BTC saja, deposit 100, bond 50) dengan `operator` = agent, ditautkan di AgentLeaderRegistry (`agentOf` = 2209). Agent membuka long 0,0002 BTC lewat `LeaderBook.trade` (tx `0x5d96b15b…c6d3`). Web membaca nama via `erc8004Name` (data: URI) tanpa perubahan kode.
- **Underwriter** ✅ (`contracts/script/Underwrite.s.sol`): underwriter `0x57A9fCEEdeB87A0561481Dd24E0489bFECb96523` setor 100 AUSD ke pool `0x75a2758568A0B4E8C195E40083FbB78539708981` milik leader demo `0xda69…3D90`: assets 100, shares 100e6, `protection()` 50 → 150 AUSD. `capacity()` tidak berubah, sesuai desain: kapasitas = min(kEquity × equity, bond / bondRatio), pool tidak dihitung.
- **Dua leader tambahan + 3 follower** ✅ (`contracts/script/Leaders.s.sol`, state `deployments/leaders-10143.json`):
  - Konservatif `0x77f406d2E4Da6CF74B11eF38D29ccC61A251606F` (owner `0xa059…DB49`): 5% DD, 3x, BTC+ETH, fee 10%. Long 0,0004 BTC + 0,005 ETH. Follower vault `0xde91e517Fa6086732E45Cd872Eb1D6c150426347` (rasio 100%, tersalin 0,0004 BTC + 0,005 ETH) dan `0x2cbb1965Bda8e9364E41828571320431b44a72eD` (rasio 50%, 0,0002 BTC + 0,002 ETH).
  - Agresif `0x989427C70fb5ED71aCe9c6c9966bd9FB2C3912C6` (owner `0x6378…9b18`): 30% DD, 10x, semua market, fee 20%. Rencana short BTC 5x, tapi Perpl testnet terus menolak fill short (custom error `0xb29d1949`, juga kadang untuk long), jadi script jatuh ke long 0,0006 BTC 5x. Follower vault `0x7E66665096b4E0471FD74AA1907274210d1fB944` (rasio 100%, tersalin 0,0006 BTC).
  - Fill Perpl testnet tidak stabil: script mencoba order dulu (prank + revert state) dan bisa dijalankan ulang untuk leg yang belum terisi.
- **Plugin `mm copas`** ✅: host `@metamask/agent-wallet` 7.0.0 jalan lokal, tapi `mm init` (juga BYOK) butuh `mm login` interaktif, jadi semua command dijalankan lewat `plugin/scripts/live.ts` (handler asli + `walletExecutor` dengan key uji `0xA38248103efa6e27bbAaB32E91F431Bfe803B662`). Hasil: `leaders`, `leader` (nama agent ERC-8004 tampil), `vault --create`, `deposit 100`, `follow` (tanpa limit → `COPAS_LIMITS_REQUIRED`, tanpa `--yes` → ditolak, lalu sukses), `sync BTC/ETH`, `status`, `tighten` (naik → `COPAS_NOT_TIGHTER`, turun → sukses), `withdraw 5` lalu `withdraw 5` lagi → `COPAS_OUTFLOW_CAP` (cap 8/hari), `underwrite <agresif> 20` lalu `--exit` (request, lalu `COPAS_TOO_EARLY`), `checkpoint` (mandat aman; leader Unbonded → `COPAS_NOTHING_TO_CHECK`), `claim` (`COPAS_ALREADY_CLAIMED`, `COPAS_NO_BREACH`), `unfollow` + `sync` unwind. Perbaikan: default chain ke testnet selama mainnet belum deploy, baca via Multicall3 (RPC publik limit 15 req/s membuat `leaders` gagal), command baru `checkpoint` dan `underwrite`, info agent ERC-8004 + pool di `leader(s)`, dry-run sebelum `sync`, `sync-contracts` hanya menyalin `<chainId>.json` + ABI UnderwriterPool/AgentLeaderRegistry. README memposisikan `mm copas` sebagai lapisan copy-trading berjaminan (bond/mandat/slash/klaim), bukan plugin trading Perpl generik seperti `mm-plugin-perpl`.
- Keeper `pnpm tick` dijalankan sekali: 5 leader, 6 vault terbaca (vault baru ikut tersinkron), 4 checkpoint terkirim; beberapa `sync` gagal karena limit RPC publik.
