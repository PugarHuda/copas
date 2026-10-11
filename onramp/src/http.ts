export class HttpError extends Error {
  constructor(public status: number, public body: unknown, url: string) {
    super(`HTTP ${status} from ${url.replace(/\/api\/(quote|status|tokens|deposit\/submit|persistent-[a-z-]+)\/[^/?]+/, '/api/$1/<key>')}`);
  }
}

export type FetchFn = typeof globalThis.fetch;

/**
 * JSON fetch with a timeout and one polite retry on 429 (honours Retry-After up to 10 s).
 * ponytail: single retry; a rejected request still counts against Aurora's hourly quota, so never loop.
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  { fetch = globalThis.fetch, timeoutMs = 20_000 }: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    if (res.ok) return body as T;
    const wait = Number(res.headers.get('retry-after'));
    if (res.status === 429 && attempt === 0 && wait > 0 && wait <= 10) {
      await sleep(wait * 1000);
      continue;
    }
    throw new HttpError(res.status, body, url);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialises calls so they are at least `intervalMs` apart (Kuru Flow JWT = 1 rps, burst 1). */
export function limiter(intervalMs: number) {
  let next = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
      next = Date.now() + intervalMs;
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}
