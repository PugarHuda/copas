// Copies the Copas ABIs and deployment files from the monorepo into the package so the
// published plugin is self-contained. Missing deployments are fine (not deployed yet).
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const abis = ["FollowerVault", "LeaderBook", "CopasRegistry", "PerplExchange", "UnderwriterPool", "AgentLeaderRegistry"];
mkdirSync(new URL("abis/", root), { recursive: true });
mkdirSync(new URL("deployments/", root), { recursive: true });

const srcAbis = new URL("../abis/", root);
if (existsSync(srcAbis)) {
  for (const n of abis) cpSync(new URL(`${n}.json`, srcAbis), new URL(`abis/${n}.json`, root));
}
const srcDep = new URL("../contracts/deployments/", root);
if (existsSync(srcDep)) {
  // only <chainId>.json; script state files (agent-/leaders-/breach-<chainId>.json) stay in the monorepo
  for (const f of readdirSync(srcDep).filter((f) => /^\d+\.json$/.test(f))) {
    cpSync(new URL(f, srcDep), new URL(`deployments/${f}`, root));
  }
}
console.log("synced abis + deployments:", readdirSync(new URL("deployments/", root)).join(", ") || "(none deployed yet)");
