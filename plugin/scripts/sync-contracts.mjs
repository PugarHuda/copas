// Copies the Copas ABIs and deployment files from the monorepo into the package so the
// published plugin is self-contained. Missing deployments are fine (not deployed yet).
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const abis = ["FollowerVault", "LeaderBook", "CopasRegistry", "PerplExchange"];
mkdirSync(new URL("abis/", root), { recursive: true });
mkdirSync(new URL("deployments/", root), { recursive: true });

const srcAbis = new URL("../abis/", root);
if (existsSync(srcAbis)) {
  for (const n of abis) cpSync(new URL(`${n}.json`, srcAbis), new URL(`abis/${n}.json`, root));
}
const srcDep = new URL("../contracts/deployments/", root);
if (existsSync(srcDep)) {
  for (const f of readdirSync(srcDep).filter((f) => f.endsWith(".json"))) {
    cpSync(new URL(f, srcDep), new URL(`deployments/${f}`, root));
  }
}
console.log("synced abis + deployments:", readdirSync(new URL("deployments/", root)).join(", ") || "(none deployed yet)");
