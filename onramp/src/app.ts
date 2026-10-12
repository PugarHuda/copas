import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { isAddress, type Address } from 'viem';
import { MONAD, SOURCES, env } from './config.js';
import { HttpError, type FetchFn } from './http.js';
import * as oneclick from './aurora/oneclick.js';
import { CONNECT_PROXY_PATH, CONNECT_URL, getIntermediary, planDepositAndFollow } from './aurora/connect.js';
import { KuruFlow, swapTxs } from './kuru/flow.js';
import * as socket from './socket.js';

export type AppOpts = {
  fetch?: FetchFn;
  auroraApiKey?: string;
  connectApiKey?: string;
  connectEnabled?: boolean;
  kuru?: KuruFlow;
  corsOrigin?: string;
};

class BadRequest extends Error {}
const need = (ok: unknown, msg: string): void => {
  if (!ok) throw new BadRequest(msg);
};
const evm = (v: unknown, name: string): Address => {
  need(typeof v === 'string' && isAddress(v), `${name} must be an EVM address`);
  return v as Address;
};
const atomic = (v: unknown, name: string): string => {
  need(typeof v === 'string' && /^[1-9]\d{0,40}$/.test(v), `${name} must be a positive integer string (atomic units)`);
  return v as string;
};
// EVM, Solana (base58) and the other origin chains: just a sane charset check, Aurora validates per chain.
const anyAddr = (v: unknown, name: string): string => {
  need(typeof v === 'string' && /^[A-Za-z0-9:._-]{20,100}$/.test(v), `${name} is not a valid address`);
  return v as string;
};
const body = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    throw new BadRequest('JSON body required');
  }
};

export function createApp(o: AppOpts = {}) {
  const apiKey = o.auroraApiKey ?? env('AURORA_API_KEY');
  const connectKey = o.connectApiKey ?? env('AURORA_CONNECT_API_KEY');
  const connectOn = o.connectEnabled ?? env('AURORA_CONNECT') === '1';
  const f = { fetch: o.fetch };
  const kuru =
    o.kuru ??
    new KuruFlow({
      fetch: o.fetch,
      referrer: env('KURU_REFERRER') as Address | undefined,
      referrerFeeBps: Number(env('KURU_REFERRER_FEE_BPS') ?? 0),
    });

  const app = new Hono();
  app.use('*', cors({ origin: o.corsOrigin ?? env('CORS_ORIGIN') ?? '*' }));

  app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof HttpError) {
      const status = err.status === 429 ? 429 : 502;
      // Upstream bodies may echo request headers; strip our keys before reflecting them to the browser.
      let s = JSON.stringify({ error: err.message, upstreamStatus: err.status, upstream: err.body });
      for (const k of [apiKey, connectKey]) if (k) s = s.split(k).join('<redacted>');
      return c.body(s, status, { 'content-type': 'application/json' });
    }
    if (err instanceof Error && err.name === 'TimeoutError') return c.json({ error: 'upstream timeout' }, 504);
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, aurora: apiKey ? 'key' : 'public-1click', connect: connectOn }));
  app.get('/aurora/sources', (c) => c.json(SOURCES));

  // --- Aurora 1Click: any-chain -> USDC on Monad (to the Mera EOA) ---
  const quoteInput = async (c: Context) => {
    const b = await body(c);
    const src = oneclick.findSource(String(b.source ?? ''));
    need(src, `unknown source; use one of ${SOURCES.map((s) => `${s.chain}:${s.symbol}`).join(', ')}`);
    return {
      b,
      src: src!,
      input: {
        originAsset: src!.assetId,
        amount: atomic(b.amount, 'amount'),
        refundTo: anyAddr(b.refundTo, 'refundTo'),
        recipient: evm(b.recipient, 'recipient'),
      },
    };
  };

  app.post('/aurora/quote', async (c) => {
    const { input } = await quoteInput(c);
    const r = await oneclick.quote({ ...input, dry: true }, { ...f, apiKey });
    return c.json(r.quote);
  });

  app.post('/aurora/deposit-address', async (c) => {
    const { b, src, input } = await quoteInput(c);
    if (b.persistent && apiKey) {
      try {
        const p = await oneclick.persistentDepositAddress(
          { recipient: input.recipient, sender: input.recipient, depositChain: src.chain === 'sol' ? 'sol' : 'evm' },
          { ...f, apiKey },
        );
        return c.json({ kind: 'persistent', ...p, statusId: p.depositAddress });
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 403)) throw e; // 403 = org not approved, fall back
      }
    }
    const r = await oneclick.depositAddress(input, { ...f, apiKey });
    return c.json({ kind: 'quote', ...r, statusId: r.depositAddress });
  });

  app.get('/aurora/status/:id', async (c) => {
    const s = await oneclick.status(c.req.param('id'), { ...f, apiKey });
    return c.json({ ...oneclick.summarize(s), raw: s });
  });

  // --- Aurora Intents Connect (alpha, flag-gated) ---
  app.post('/aurora/connect/plan', async (c) => {
    need(connectOn, 'Intents Connect disabled (set AURORA_CONNECT=1)');
    const b = await body(c);
    const wallet = evm(b.wallet, 'wallet');
    const intermediary = b.intermediary ? evm(b.intermediary, 'intermediary') : (await getIntermediary(wallet, f)).evm;
    const params = await planDepositAndFollow(kuru, {
      intermediary,
      vault: evm(b.vault, 'vault'),
      expectedUsdc: atomic(b.expectedUsdc, 'expectedUsdc'),
      reserveBps: typeof b.reserveBps === 'number' ? b.reserveBps : undefined,
    });
    return c.json({ intermediary, params });
  });

  // Key proxy for the browser SDK (apiKeyProxyUrl = <this server>/aurora/connect). Only the two create calls.
  app.post('/aurora/connect/*', async (c) => {
    const path = c.req.path.slice('/aurora/connect'.length);
    if (!CONNECT_PROXY_PATH.test(path)) return c.json({ error: 'not proxied' }, 404);
    if (!connectOn || !connectKey) return c.json({ error: 'Intents Connect not configured' }, 503);
    const res = await (o.fetch ?? fetch)(`${CONNECT_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': connectKey },
      body: await c.req.text(),
      signal: AbortSignal.timeout(30_000),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  });

  // --- Kuru Flow: USDC/MON -> AUSD (+ optional FollowerVault deposit txs) ---
  app.post('/kuru/quote', async (c) => {
    const b = await body(c);
    const userAddress = evm(b.userAddress, 'userAddress');
    const tokenIn = b.tokenIn === 'MON' ? MONAD.MON : b.tokenIn === 'USDC' || !b.tokenIn ? MONAD.USDC : evm(b.tokenIn, 'tokenIn');
    const amount = atomic(b.amount, 'amount');
    const vault = b.vault ? evm(b.vault, 'vault') : undefined;
    const q = await kuru.quote({ userAddress, tokenIn, amount });
    return c.json({ output: q.output, minOut: q.minOut, txs: swapTxs(q, tokenIn, amount, vault) });
  });

  // --- Socket V3: USDT (BSC) -> AUSD on Monad deposit address ---
  app.post('/socket/deposit-address', async (c) => {
    const b = await body(c);
    const receiver = evm(b.receiver, 'receiver');
    // Any EVM source in SOURCES (default USDT on BSC); Socket bridges straight into AUSD.
    const src = oneclick.findSource(String(b.source ?? 'bsc:USDT'));
    const originChainId = src && socket.CHAIN_IDS[src.chain];
    need(originChainId, `unknown source for Socket; use one of ${SOURCES.filter((s) => socket.CHAIN_IDS[s.chain]).map((s) => `${s.chain}:${s.symbol}`).join(', ')}`);
    const r = await socket.depositAddress(
      {
        receiver,
        refundAddress: b.refundAddress ? evm(b.refundAddress, 'refundAddress') : receiver,
        amount: atomic(b.amount, 'amount'),
        originChainId,
        inputToken: src!.contractAddress ?? socket.NATIVE,
      },
      f,
    );
    return c.json({ ...r, statusId: r.quoteId });
  });

  app.get('/socket/status/:id', async (c) => c.json(await socket.status(c.req.param('id'), f)));

  return app;
}
