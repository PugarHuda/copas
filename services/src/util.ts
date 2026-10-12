export type Fetch = typeof globalThis.fetch;

/** Thrown when a service needs a key/env that is not configured. The HTTP layer maps it to 503. */
export class ServiceUnavailable extends Error {
  constructor(public missing: string, message?: string) {
    super(message ?? `${missing} is not configured`);
  }
}

export const env = (k: string) => process.env[k]?.trim() || undefined;
/** Monad JSON-RPC per chain id (anything but testnet reads mainnet). */
export const rpcUrl = (chainId: number) => (chainId === 10143 ? (env("MONAD_TESTNET_RPC_URL") ?? "https://testnet-rpc.monad.xyz") : (env("MONAD_RPC_URL") ?? "https://rpc.monad.xyz"));

export function requireEnv(k: string): string {
  const v = env(k);
  if (!v) throw new ServiceUnavailable(k);
  return v;
}

export async function getJson<T = any>(url: string, init: RequestInit = {}, f: Fetch = fetch): Promise<T> {
  const r = await f(url, init);
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

/** Deterministic JSON: object keys sorted recursively. Used for hashes and attestations. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as any)[k])]),
    );
  }
  return v;
}

export const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
