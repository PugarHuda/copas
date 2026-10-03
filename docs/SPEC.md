# Copas — Spesifikasi Produk & Teknis

> Versi 1.0 · 3 Okt 2026 · Monad Metropolis Hackathon, Track 01 Onchain Finance & Trading
> Deadline submit: **14 Okt 2026 10:59 WIB (03:59 UTC)**
> Sumber riset: `../ANALISIS_METROPOLIS.md` §15.10–15.15, `../riset/verify_bonded_copy.md`, `../riset/verify_funding_market.md`

---

## 0. Ringkasan satu paragraf

**Copas** adalah copy trading di Monad di mana setiap leader wajib menaruh **jaminan (bond) AUSD** dan mendeklarasikan **mandat** (batas drawdown, market, leverage, ukuran). Follower menyalin posisi perps leader di **Perpl** lewat vault miliknya sendiri yang hanya bisa "menyalin dalam batas". Kontrak membaca equity leader **langsung dari state Perpl** (tanpa oracle). Bila leader melanggar mandat, bond **dipotong otomatis dan dibayarkan ke follower** sebesar kerugian nyata mereka. Di atasnya: underwriter yang ikut menjamin leader, token DOWN (CDS atas trader) di Kuru, analis risiko AI (Kimi), penemu leader (Nansen), leader berupa AI agent ber-bond (ERC-8004), login passkey Mera, deposit any-chain (Aurora), plugin MetaMask `mm copas`, indexer Envio, dashboard risiko Perpl, workflow CRE.

**Kalimat pitch:** "Di Perpl, 71% trader rugi dalam 30 hari dan leader terbaik bisa menarik dananya kapan saja. Di Copas, leader yang ingin diikuti harus mempertaruhkan uangnya sendiri — kalau ia ingkar janji, kamu yang dibayar."

---

## 1. Prinsip desain (tidak boleh dilanggar)

1. **Dana follower tidak pernah dipegang backend.** Dana ada di `FollowerVault` yang `owner`-nya EOA Mera follower. `withdraw` hanya ke `owner`.
2. **Copy-only.** `sync()` boleh dipanggil siapa saja, tapi hanya bisa menggerakkan posisi follower menuju `rasio × posisi leader` yang ada onchain, di dalam batas follower. Tidak ada diskresi bot.
3. **Tanpa oracle untuk logika uang.** Equity, drawdown, breach, dan settlement dihitung dari view Perpl (`getAccountById`, `getPosition`) di blok yang sama.
4. **Batas ditegakkan di kontrak**, bukan di prompt LLM atau policy offchain. Policy Privy = lapisan kedua.
5. **AI menjelaskan, tidak mengeksekusi.** LLM (Kimi) hanya memberi analisis, skor, peringatan. Eksekusi = aturan deterministik.
6. **Jujur soal risiko.** UI selalu menampilkan "perlindungan maksimal = bond / AUM follower" dan risiko sisa (drawdown intra-blok, kontrak belum diaudit).
7. **Mainnet dengan cap kecil.** Deposit per vault di mainnet dibatasi (default 100 AUSD) sampai ada audit.

---

## 2. Arsitektur

```
                        ┌──────────────────────── Web (Next.js) ───────────────────────┐
 User (passkey Mera) ──►│ Leaderboard · Profil leader · Follow · Vault saya · Jadi leader│
                        │ Underwrite · Pasar DOWN · Proof · Analytics Perpl · Backtest  │
                        └───────┬───────────────────────┬─────────────────────┬────────┘
                                │ tx (EOA Mera)         │ GraphQL             │ REST
                                ▼                       ▼                     ▼
  ┌──────────── Kontrak Copas (Monad 143 / 10143) ───────────┐   ┌─ Envio HyperIndex ─┐  ┌─ API Copas ─────────┐
  │ CopasRegistry (factory, config, allowlist market)         │   │ Exchange Perpl +   │  │ Kimi analyst        │
  │ LeaderBook  (akun Perpl leader, unit, epoch, mandat, bond)│◄──│ kontrak Copas      │  │ Nansen discovery    │
  │ FollowerVault (akun Perpl follower, sync copy-only, claim)│   └────────────────────┘  │ Backtest engine     │
  │ UnderwriterPool (per leader)                              │                           │ Tenderly simulate   │
  │ BreachMarket (UP/DOWN per leader per epoch)               │                           │ Aurora/Socket quote │
  │ AgentLeaderRegistry (ERC-8004 link)                       │                           └─────────────────────┘
  └──────────────┬────────────────────────────────────────────┘
                 │ execOrder / getPosition / getAccountById
                 ▼
         Perpl Exchange (mainnet 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F)
                 ▲
  ┌──────────────┴───────────── Keeper (Node, Privy server wallet + policy) ──────────────┐
  │ subscribe log leader → sync(follower) · checkpoint(leader) tiap N blok · epoch roll   │
  └───────────────────────────────────────────────────────────────────────────────────────┘
  CRE workflow (cron): checkpoint + cek harga eksternal + ringkasan LLM JSON → tulis onchain
  Alchemy Notify + Telegram bot: alert · MetaMask Agent Wallet plugin `mm copas`
```

### 2.1 Repo layout

```
copas/
  contracts/     Foundry: src/, test/, script/, abi/PerplExchange.json
  web/           Next.js 15 App Router, wagmi/viem, Mera
  indexer/       Envio HyperIndex v3 (config.yaml, schema.graphql, src/handlers)
  keeper/        Node TS: sync/checkpoint bot, Privy signer
  api/           (di dalam web/app/api) Kimi, Nansen, backtest, Tenderly, Aurora
  cre/           Chainlink CRE workflow (TypeScript)
  plugin/        MetaMask Agent Wallet plugin + skills/copas/SKILL.md
  docs/          SPEC.md, SUBMISSION.md, PRIVY.md, NANSEN.md, KIMI-ARTICLE.md
```

### 2.2 Konstanta jaringan

| Item | Mainnet (143) | Testnet (10143) |
|---|---|---|
| RPC | `https://rpc.monad.xyz` | `https://testnet-rpc.monad.xyz` |
| Perpl Exchange | `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` |
| AUSD (6 desimal) | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` | `0xa9012a055bd4e0edff8ce09f960291c09d5322dc` (AUSD Perpl testnet) |
| Market leader (allowlist) | BTC=1, MON=10, ETH=20, SOL=31 (terverifikasi `getPerpetualInfo` 3 Okt; lain: HYPE 40, ZEC 50, LIT 60, VVV 70, PUMP 90, NEAR 100) | cek |
| Min buka akun Perpl | 10 AUSD (`getMinAccountOpenCNS`) | cek |
| Fee | taker 3,45 bp, maker 0,45 bp | — |
| `orderType` | 0 OpenLong · 1 OpenShort · 2 CloseLong · 3 CloseShort | sama |

---

## 3. Model data & matematika inti

### 3.1 Equity akun Perpl
```
equity(acct) = acct.balanceCNS + Σ_{p ∈ markets} (pos_p.depositCNS + pos_p.pnlCNS)
```
`pnlCNS = deltaPnlCNS + premiumPnlCNS` (funding termasuk). Jika `markPriceValid == false` untuk market dengan posisi terbuka → equity dianggap **tidak valid** (checkpoint di-skip).

### 3.2 Unitisasi leader (arus dana netral)
- `units` total, `u = equity / units` (harga per unit, 1e18).
- Setoran `a`: `mint = a × units / equity` (atau `a × 1e18 / 1e18` saat units = 0, u awal = 1).
- Penarikan: bakar unit pada `u` saat itu, hanya di batas epoch (lihat A4).

### 3.3 Epoch & high-water mark
- Epoch panjang tetap `epochLen` (default 7 hari; demo 1 jam). `epochStart_e`, `peak_e = u` saat epoch dibuka.
- `checkpoint()`: baca `u`; `peak_e = max(peak_e, u)`; `dd = 1 − u/peak_e`; jika `dd > maxDD_bps` → **breach**.
- Breach juga dipicu pelanggaran mandat (A2) yang terdeteksi saat `trade()` atau `checkpoint()`.

### 3.4 Slashing & klaim
- Saat breach di epoch e: `slash_e = bondLocked_e` (bond leader + porsi underwriter yang dipertaruhkan).
- Snapshot follower di awal epoch: `cap_i` = equity vault i saat `sync` pertama di epoch e atau saat epoch roll; hanya follower aktif sejak awal epoch yang eligible.
- `loss_i = max(0, equityStart_i − equityNow_i)` saat klaim (dikunci pada saat breach + window klaim).
- `claim_i = min(slash_e × cap_i / Σcap, loss_i)`. Pull-based.
- Sisa `slash_e − Σclaim` → `reserve` protokol (parameter: `remainderToLeaderBps`, default 0).
- Setelah breach: status `Breached`, `sync` reduce-only, follower baru diblokir sampai leader re-bond di epoch berikutnya.

### 3.5 Batas AUM (anti front-run)
`Σ cap follower ≤ min(kEquity × equityLeader, bond × 10_000 / bondRatioBps)`. Default `kEquity = 3`. Sisi bond adalah kebalikan persis dari `minBond` (§3.6), jadi menerima follower tidak pernah membuat leader jatuh ke `Unbonded`.

### 3.6 Bond dinamis (A3)
`minBond = max(minBondAbs, aumFollower × bondRatioBps / 10_000)`. Default `minBondAbs = 25 AUSD` (mainnet demo), `bondRatioBps = 1000` (10%). Jika `bond < minBond` → `Unbonded`.

---

## 4. Daftar fitur lengkap (P0 → P3)

Format tiap fitur: **Apa** · **Perilaku** · **Kontrak/komponen** · **UI** · **Kriteria selesai (AC)** · **Untuk (juri/bounty)**.

### A. Sisi leader

#### A1 — Bond + deklarasi drawdown + slashing otomatis · P0
- **Apa:** leader menaruh bond AUSD dan menyatakan `maxDDbps` per epoch.
- **Perilaku:** §3.3–3.4. Deklarasi baru berlaku epoch berikutnya.
- **Kontrak:** `LeaderBook.postBond(uint256)`, `declare(Mandate)`, `checkpoint()`, `_breach(reason)`, event `BondPosted`, `MandateDeclared`, `Checkpoint(u, peak, dd)`, `Breached(epoch, reason, slash)`.
- **UI:** `/become-leader` langkah bond; badge "Bond 500 AUSD · janji DD ≤ 15%".
- **AC:** test fork: leader rugi > maxDD → `checkpoint()` emit `Breached`; Σclaim ≤ slash ≤ bond (invariant fuzz).
- **Untuk:** inti, Originality, Track 01.

#### A2 — Mandat onchain · P1
- **Apa:** leader mendeklarasikan `allowedMarkets` (bitmask), `maxLeverageHdths`, `maxNotionalCNS`, `maxDDbps`, `epochLen`.
- **Perilaku:** `trade()` menolak order di luar mandat (revert) **dan** `checkpoint()` mendeteksi posisi di luar mandat (mis. leverage efektif naik karena rugi) → breach dengan `reason = MANDATE`.
- **Kontrak:** struct `Mandate`, `LeaderBook.trade(OrderDesc)` dengan validasi.
- **UI:** kartu mandat di profil leader, ikon tiap batas, status hijau/merah live.
- **AC:** test: order leverage > max revert; leverage efektif > max saat checkpoint → breach.
- **Untuk:** Technical, Frankie, Evan Feng.

#### A3 — Bond dinamis · P1
- §3.6. `LeaderBook.minBond()` view; follow baru revert jika menambah AUM di atas kapasitas bond.
- **UI:** bar "kapasitas follower terisi 72%".
- **AC:** test: AUM naik → `minBond` naik → leader `Unbonded` bila tidak top-up.

#### A4 — Unbonding period · P1
- **Apa:** `requestUnbond(amt)` → bisa ditarik setelah `epochEnd + unbondDelay` (default 1 epoch). Withdraw modal leader juga hanya di batas epoch.
- **Perilaku:** selama menunggu, bond tetap bisa di-slash. Follower diberi notifikasi "leader akan keluar".
- **AC:** test: withdraw sebelum waktu revert; breach selama unbonding tetap memotong.

#### A5 — Performance fee di atas HWM + escrow yang bisa di-slash · P1
- **Apa:** fee `feeBps` (≤ 2000) atas profit follower di atas HWM follower. Fee masuk `feeEscrow` leader, rilis ke leader di akhir epoch tanpa breach; jika breach → escrow ikut `slash_e`.
- **Kontrak:** `FollowerVault.settleFee()` di epoch roll; `LeaderBook.feeEscrow`.
- **AC:** test: profit → fee terkunci; breach → fee hangus ke follower.

#### A6 — Tier mandat · P2
- Preset: **Konservatif** (DD 5%, lev 3x, BTC/ETH), **Moderat** (DD 15%, lev 5x, +SOL), **Agresif** (DD 30%, lev 10x, +MON). Leader boleh custom. Hanya UI + default param.

#### A7 — Impor rekam jejak · P2
- **Apa:** histori PnL Perpl leader (leaderboard API + Envio) diringkas → `trackRecordHash` + metrik (PnL 30h, maxDD, win rate) ditulis sebagai atestasi oleh registry (ditandatangani keeper; ditampilkan sebagai "offchain attested").
- **AC:** profil leader menampilkan rekam jejak sebelum Copas dengan label sumber.

#### A8 — Leader AI agent ber-bond (ERC-8004) · P1
- **Apa:** agent trading otonom boleh jadi leader; `LeaderBook.operator` = alamat agent (EOA/Privy wallet agent), `owner` = manusia/organisasi yang menaruh bond. Agent didaftarkan di registry identitas ERC-8004 (Monad) dan ditautkan `agentId`.
- **Perilaku:** sama dengan leader manusia; mandat & bond membuat agent "punya kulit". Agent demo: strategi sederhana momentum/mean-reversion BTC di testnet (deterministik + penjelasan Kimi).
- **Kontrak:** `LeaderBook.setOperator(addr)`, `AgentLeaderRegistry.link(leaderBook, erc8004AgentId)`.
- **UI:** badge "🤖 AI Agent · ERC-8004 #id".
- **AC:** agent menjalankan trade lewat `trade()`, dibatasi mandat; breach agent = slash bond owner.
- **Untuk:** Alex Svanevik, Frankie, tema guardrail agent, Grand Champion.

### B. Pasar risiko

#### B1 — Underwriter / backer · P1
- **Apa:** pihak ketiga setor AUSD ke `UnderwriterPool(leader)`; dana menambah bond yang dipertaruhkan; underwriter menerima `uwFeeShareBps` dari fee leader (default 30% dari fee) pro-rata.
- **Perilaku:** breach → pool ikut dipotong pro-rata setelah bond leader (leader = first loss). Unbonding sama dengan A4.
- **Kontrak:** `UnderwriterPool.deposit/withdrawRequest/claimFees`, share token ERC-20 `cpUW-<leader>`.
- **UI:** `/underwrite`: APR historis fee, risiko breach, posisi.
- **AC:** test: urutan loss leader → underwriter; fee terbagi benar.

#### B2 — Token DOWN (BreachMarket) di Kuru · P2
- **Apa:** per leader per epoch: setor 1 AUSD → 1 UP + 1 DOWN. Settle dari `LeaderBook.breached(epoch)`: DOWN = 1 AUSD jika breach, UP = 1 AUSD jika tidak.
- **Kontrak:** `BreachMarket.mint/redeemPair/settle/redeem`, token ERC-20 per seri.
- **Kuru:** market DOWN/AUSD di Kuru V1 testnet (permissionless) via `deployProxy`; UI order sederhana (limit/market) memanggil router Kuru. Mainnet: hanya mint/redeem (listing Kuru mainnet permissioned).
- **UI:** `/market/[leader]`: harga DOWN = "probabilitas breach menurut pasar".
- **AC:** testnet: mint, trade DOWN di Kuru, settle, redeem.
- **Untuk:** Kuru New Assets / Consumer, Originality.

#### B3 — Insured follow · P3
- Follower membayar premi (bps per epoch) ke UnderwriterPool untuk proteksi tambahan sampai `coverCap`. Diimplementasi sebagai klaim prioritas ke pool. Hanya bila waktu ada.

### C. Sisi follower

#### C1 — FollowerVault + `sync()` copy-only · P0
- **Kontrak:** `FollowerVault` (clone via `CopasRegistry.createVault`): `owner`, `deposit(amt)`, `follow(leader, Params)`, `unfollow()`, `sync(perpId)` permissionless, `withdraw(amt)` hanya ke owner, `equity()`.
- **Params:** `ratioBps`, `maxNotionalCNS`, `maxLeverageHdths`, `maxChaseBps`, `priceBandBps`, `stopLossBps` (C2), `marketsMask`.
- **sync:** `target = sign(L) × min(|L.lot| × ratio, cap)`; jika leader `Breached/Unbonded` → target 0 (reduce-only); IOC order dengan harga batas `mark ± priceBand`; tolak jika `|mark − L.entry| > maxChase` untuk penambahan posisi.
- **AC:** fork test: leader buka long → `sync` → follower long sebesar rasio; leader tutup → follower tutup; panggilan `sync` oleh pihak asing tidak bisa mengubah ke arah selain target.

#### C2 — Kontrol risiko follower · P1
- `stopLossBps` (stop-copy otomatis bila DD vault > batas → target 0 & `paused`), `marketsMask`, `maxLeverageHdths`. UI risk disclosure.
- **AC:** test stop-loss vault memicu pause.

#### C3 — Backtest sebelum follow · P1
- **Apa:** replay 30 hari histori fill leader (Envio/Perpl API) dengan setelan follower → kurva equity, max DD, berapa kali mandat akan breach, kompensasi teoretis.
- **Komponen:** `web/app/api/backtest` (TS), sumber data `trading/leaderboard` + fills.
- **UI:** grafik di ticket follow.
- **AC:** hasil deterministik; menampilkan asumsi (fee taker, slippage).

#### C4 — Preview simulasi Tenderly · P2
- `tenderly_simulateTransaction` untuk tx `deposit+follow`, tampilkan perubahan saldo & event. Fallback: `eth_call`.

#### C5 — Portofolio leader · P2
- `PortfolioVault`: owner membagi dana ke beberapa FollowerVault dengan bobot; rebalance manual/otomatis berdasar skor risiko-bond. MVP: UI yang membuat beberapa vault + tombol rebalance.

#### C6 — Auto-unfollow · P2
- Kondisi: leader `Unbonded/Breached`, mandat diubah ke arah lebih berisiko, atau sinyal AI "style drift" (D1) → keeper memanggil `pauseIfUnsafe(vault)` (hanya untuk kondisi onchain; sinyal AI = notifikasi + saran, follower yang memutuskan).

#### C7 — Bukti eksekusi per copy · P1
- Envio mencatat fill leader & follower; UI menampilkan per copy: harga leader, harga follower, slippage bps, fee, funding, jeda blok.
- **AC:** tabel bukti eksekusi di `/me` dan `/proof`.

#### C8 — Klaim slashing satu klik · P0
- `FollowerVault.claim(leader, epoch)` → memanggil `LeaderBook.claimFor(vault, epoch)`; dana masuk vault (atau langsung ke owner).
- **AC:** test end-to-end breach → claim.

### D. Lapisan AI

#### D1 — Analis risiko AI (Kimi K3) · P1
- **Apa:** untuk tiap leader: ringkasan gaya, deteksi tilt/revenge trading (ukuran naik setelah rugi, frekuensi naik), style drift (market/leverage berubah), ringkasan mingguan. Output JSON terstruktur + penjelasan Bahasa Indonesia/Inggris.
- **Provenance:** tiap analisis meminta Kimi Request Signature (`X-Msh-Request-Nonce`, verifikasi `/v1/signatures/verify`), hash disimpan & ditampilkan.
- **Catatan API:** jangan kirim `temperature`; `reasoning_effort: "high"`.
- **AC:** halaman profil menampilkan analisis + tautan verifikasi signature. Artikel blog untuk bounty Kimi.

#### D2 — Penemu leader via Nansen · P1
- Endpoint: `smart-money/netflow`, `smart-money/dex-trades`, `profiler/address/*` (chain `monad`), pembayaran x402 USDC di Monad (`@x402/fetch`, header `PAYMENT-SIGNATURE`) atau API key.
- **Fitur:** (a) kandidat leader = alamat smart money yang aktif di Perpl; (b) "Smart money alignment": persentase posisi leader searah netflow smart money; (c) skor komposit — tidak menampilkan holdings mentah (lisensi). Label "Powered by Nansen".
- **AC:** dokumen `docs/NANSEN.md` mencantumkan endpoint yang dipakai.

#### D3 — Agent penantang sebelum follow · P2
- Kimi menghasilkan 3 argumen "kenapa jangan follow leader ini" berbasis data (breach historis, korelasi, konsentrasi). Ditampilkan di ticket follow.

#### D4 — Agent bayar data sendiri via x402 · P2
- Wallet agent (Privy) membayar Nansen per panggilan; biaya per keputusan ditampilkan di UI ("analisis ini biaya $0,13").

### E. Akun, keamanan, privasi

#### E1 — Login passkey Mera (web) · P0
- `@category-labs/mera` di web, satu ceremony, EOA turunan PRF. Lolos **stateless test**: hapus storage / profil browser baru → akses rekonstruksi dari passkey.
- **AC:** time-to-first-tx diukur & ditampilkan di README (tap + detik).

#### E2 — Session Mera · P1
- Aksi prompt-free: `sync` manual, `checkpoint`, ubah setelan dalam batas lebih ketat. Re-prompt: `withdraw`, `follow` leader baru, menaikkan batas, `postBond`, `requestUnbond`. Session TTL 30 menit, banner kedaluwarsa.

#### E3 — Feed strategi leader terenkripsi · P1
- Leader menulis catatan strategi; dienkripsi AES-GCM dengan kunci konten acak; kunci konten dibungkus untuk tiap follower aktif memakai kunci X25519 turunan PRF (`prfSalt = sha256("copas.feed.v1")`). Ciphertext di storage tak dipercaya (API/IPFS). Follower membuka dengan passkey di device mana pun.
- **AC:** demo cross-device: device kedua membuka catatan yang sama; tidak ada kunci di disk/server.
- **Untuk:** Mera Many Keys.

#### E4 — Identitas follower tak tertaut · P2
- Namespace PRF per leader (`prfSalt = sha256("copas.follow.v1:" + leader)`) → alamat vault owner berbeda per leader; profil sosial tidak bisa menautkan.

#### E5 — Vault kunci API · P3
- Simpan kunci (mis. Perpl API key leader) terenkripsi di bawah passkey (`prfSalt = sha256("copas.vault.v1")`).

#### E6 — Privy · P1
- **Server wallet** keeper dengan **policy** (chain 143/10143, allowlist `sync`/`checkpoint`/`rollEpoch` ke kontrak Copas, deny transfer AUSD/Perpl langsung, deny 7702/personal_sign/typed data).
- **Gas sponsorship** (`sponsor: true`) untuk tx keeper.
- **Intents** untuk aksi admin (ubah policy, naikkan cap) dengan quorum.
- **Swap API** untuk onboarding token → AUSD.
- **Demo DENY:** bot mencoba transfer AUSD → ditolak policy, ditampilkan di `/proof`.
- **AC:** `docs/PRIVY.md` mendaftar semua fitur Privy yang dipakai.

#### E7 — Blockaid · P3
- Scan tx vault (`deposit`, `follow`) via API Blockaid sebelum tanda tangan; sanitasi metadata token sebelum masuk prompt AI.

### F. Onboarding dana

#### F1 — Aurora Intents Connect: deposit any-chain → follow · P1
- Recipe: dana dari 31+ chain → USDC di Monad → swap ke AUSD (Kuru Flow/aggregator) → `FollowerVault.depositAndFollow(...)`. Tanpa `quote.recipient` di bridge-in; API key lewat proxy server; tangani refund.
- **AC:** demo live dana dari Base/Arbitrum tiba dan langsung jadi posisi follow.

#### F2 — Socket deposit address (USDT BSC → AUSD) · P2
- Untuk user Indodax/Binance. UI menampilkan alamat deposit + status.

#### F3 — Swap onboarding via Kuru Flow · P2
- USDC/MON → AUSD lewat Kuru Flow API (JWT, 1 req/s). Memberi volume ke Kuru.

### G. Data, infra, verifikasi

#### G1 — Indexer Envio · P1
- Source: Perpl Exchange (Position*, Collateral*, Maker/TakerOrderFilledV2) + kontrak Copas (semua event).
- Entity: `Leader`, `Epoch`, `Checkpoint`, `Breach`, `Follower`, `Vault`, `CopyFill`, `Claim`, `UnderwriterPosition`, `PerplMarketDaily`, `PerplWalletStats` (agregat).
- GraphQL subscription untuk feed live.
- **AC:** repo berisi `config.yaml`, `schema.graphql`, handler; deploy Envio Cloud.

#### G2 — Dashboard Perpl Analytics/Risk · P1
- Protocol: volume 24h/7d/30d/all, OI, TVL, fee, user aktif, time-series, deposit/withdraw flow, per market + skew long/short, likuidasi, funding.
- Wallet: search alamat → posisi (size, entry, leverage, uPnL, harga likuidasi), histori trade + realized PnL, win rate, profit factor, max DD, streak, hold time, best/worst market, watch & compare, insight AI.
- Dark mode, cepat, tanpa clutter.
- **AC:** memenuhi seluruh daftar deliverable bounty Perpl Analytics.

#### G3 — Workflow Chainlink CRE · P2
- Cron 5 menit: baca daftar leader aktif (GraphQL Envio) → panggil API harga eksternal (sanity check mark vs CEX) → LLM ringkas risiko (JSON terstruktur) → tulis `checkpoint` + `RiskNote` onchain via consumer. Simulasi `cre workflow simulate` (MockForwarder).
- **AC:** video simulasi CLI.

#### G4 — Alert · P2
- Alchemy Notify webhook (address activity kontrak Copas) + bot Telegram: leader buka/tutup posisi, checkpoint mendekati batas (DD > 80% batas), breach, klaim tersedia, leader request unbond.

#### G5 — Halaman Proof · P1
- Daftar alamat kontrak (explorer), setiap breach/slash dengan tx, rumus & angka yang bisa direproduksi ("klik untuk hitung ulang equity di blok X"), invariant solvensi live (`Σ saldo pool ≥ Σ kewajiban`), log DENY Privy, signature Kimi.

#### G6 — Fuzz/invariant test · P1
- Invariant: Σclaim ≤ slash ≤ bond+uw; vault tidak bisa withdraw ke non-owner; `sync` tidak pernah menambah |posisi| melebihi target; unit price tidak berubah karena deposit/withdraw. `forge test` + catatan untuk ack3.

#### G7 — Portfolio lintas protokol (BlockVision/Zerion) · P3
- Kartu "aset lain kamu" di `/me` memakai `defiPortfolio` BlockVision.

### H. Distribusi & sosial

#### H1 — Plugin MetaMask Agent Wallet `mm copas` · P1
- Perintah: `mm copas leaders`, `mm copas follow <leader> --ratio --max-notional --max-lev`, `mm copas status`, `mm copas claim`, `mm copas unfollow`. Semua tx lewat `walletExecutor` (tanpa key handling). `skills/copas/SKILL.md`.
- **AC:** plugin terpasang di Agent Wallet ≥ v7, demo ≤ 5 menit.

#### H2 — Kartu profil leader shareable · P2
- OG image dinamis (`/api/og/leader/[addr]`): PnL terverifikasi, bond, mandat, rekam breach. Tombol share ke X/Telegram.

#### H3 — Liga musiman · P2
- Musim 2 minggu; peringkat leader ber-bond berdasar return/DD dengan syarat tanpa breach; hadiah dari reserve protokol. Mendorong OI Perpl.

#### H4 — Referral · P3
- Kode referral → `referrer` di `follow()`, mendapat `refBps` dari fee protokol.

#### H5 — i18n ID/EN + onboarding komunitas · P1
- Semua UI dwibahasa (Bahasa Indonesia default untuk locale `id`). Halaman komunitas Ethereum Jakarta / DevWeb3Jogja.

### I. Bisnis & traction

- **I1 · P0** Leader nyata: undang 6–7 trader Perpl diskresioner (lihat `riset/verify_bonded_copy.md` §4.3) + leader tim dengan bond nyata; "shadow leaders" (read-only) untuk yang belum bergabung.
- **I2 · P0** Follower nyata dari komunitas (modal kecil, mainnet), log PnL & kompensasi.
- **I3 · P1** Model pendapatan: `protocolFeeBps` dari performance fee + spread premi underwriter; proyeksi di `docs/SUBMISSION.md`.
- **I4 · P1** Progress update publik mingguan; balas thread Alex Svanevik (28 Sep) dengan demo.

---

## 5. Antarmuka kontrak (draft)

```solidity
struct Mandate { uint64 maxDDbps; uint64 maxLeverageHdths; uint128 maxNotionalCNS; uint256 marketsMask; uint64 epochLen; uint64 feeBps; }
enum LeaderStatus { Active, Unbonded, Breached, Closed }

interface ILeaderBook {
  function owner() external view returns (address);
  function operator() external view returns (address);
  function perplAccountId() external view returns (uint256);
  function status() external view returns (LeaderStatus);
  function currentEpoch() external view returns (uint256);
  function equity() external view returns (uint256 equityCNS, bool valid);
  function unitPrice() external view returns (uint256);
  function minBond() external view returns (uint256);
  function aumCapacity() external view returns (uint256);
  function breached(uint256 epoch) external view returns (bool);

  function deposit(uint256 amt) external;               // owner
  function requestWithdraw(uint256 units) external;     // owner, efektif di epoch roll
  function postBond(uint256 amt) external;              // owner
  function requestUnbond(uint256 amt) external;         // owner
  function declare(Mandate calldata m) external;        // owner, berlaku epoch berikut
  function setOperator(address op) external;            // owner (AI agent)
  function trade(OrderDesc calldata o) external;        // operator, cek mandat
  function checkpoint() external;                       // siapa saja
  function rollEpoch() external;                        // siapa saja, setelah epochEnd
  function claimFor(address vault, uint256 epoch) external returns (uint256);
}

interface IFollowerVault {
  struct Params { uint32 ratioBps; uint128 maxNotionalCNS; uint32 maxLeverageHdths; uint32 maxChaseBps; uint32 priceBandBps; uint32 stopLossBps; uint256 marketsMask; }
  function owner() external view returns (address);
  function leader() external view returns (address);
  function deposit(uint256 amt) external;
  function follow(address leaderBook, Params calldata p) external;
  function unfollow() external;
  function sync(uint256 perpId) external;               // siapa saja, copy-only
  function withdraw(uint256 amt) external;              // hanya ke owner
  function claim(uint256 epoch) external;
  function equity() external view returns (uint256 equityCNS, bool valid);
}
```

---

## 6. Rencana eksekusi (urutan bangun)

| Hari | Target | Fitur |
|---|---|---|
| 3 Okt | **Spike kritis**: kontrak buka akun Perpl + execOrder IOC di fork mainnet/testnet; baca equity. SPEC, scaffold monorepo | — |
| 4 Okt | `LeaderBook` (unit, epoch, mandat, bond, checkpoint, breach) + test | A1, A2, A3, A4 |
| 5 Okt | `FollowerVault` (sync copy-only, batas, stop-loss, claim) + fuzz invariant | C1, C2, C8, G6 |
| 6 Okt | Fee escrow, UnderwriterPool, AgentLeader; deploy testnet; keeper + Privy policy | A5, B1, A8, E6 |
| 7 Okt | Indexer Envio + web dasar (Mera login, leaderboard, profil, follow, vault) | G1, E1, E2, H5 |
| 8 Okt | Dashboard Perpl Analytics, bukti eksekusi, Proof, backtest | G2, C7, G5, C3 |
| 9 Okt | Kimi analyst, Nansen discovery, feed terenkripsi Mera | D1, D2, E3 |
| 10 Okt | Aurora deposit→follow, Kuru Flow, MetaMask plugin | F1, F3, H1 |
| 11 Okt | Deploy mainnet cap kecil, leader & follower nyata, BreachMarket + Kuru testnet, CRE, alert | I1, I2, B2, G3, G4 |
| 12 Okt | P2/P3 sisa, polish, artikel Kimi, docs bounty | sisa |
| 13 Okt | Demo video 3 menit, pitch 2 menit, submit | — |

Gate: bila spike kritis (3 Okt) gagal → fallback desain B (leader/follower EOA + keeper Envio + slashing via atestasi keeper/CRE).

---

## 7. Deliverable submit (checklist)

- [ ] Logo (≤ 3 MB)
- [ ] Repo GitHub publik + akses `metropolis@hackathon.monad.xyz`
- [ ] Technical demo ≤ 3 menit (produk live)
- [ ] Pitch video ≤ 2 menit
- [ ] Live link + instruksi + akun uji
- [ ] Per bounty: deskripsi + video ≤ 2 menit (MetaMask ≤ 5 menit), artikel Kimi terbit, `docs/NANSEN.md`, `docs/PRIVY.md`, link Envio, link dashboard Perpl, simulasi CRE
- [ ] Community field: Ethereum Jakarta / DevWeb3Jogja
