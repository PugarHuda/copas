// Records web/e2e/feed.spec.ts (Mera "one passkey, many keys", real txs on testnet) with Playwright video, for the
// bounty-mera-keys clip. Run from web/: FUNDER_KEY=... npx playwright test -c ../video/feed.config.mjs
export default {
  testDir: "../web/e2e",
  testMatch: "feed.spec.ts",
  outputDir: "./out/feed-results",
  timeout: 900_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "https://copas-mocha.vercel.app",
    navigationTimeout: 60_000,
    video: { mode: "on", size: { width: 1440, height: 900 } },
  },
  projects: [{ name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } }],
};
