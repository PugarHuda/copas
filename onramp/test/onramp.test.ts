import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { depositAndFollowRecipe } from '../src/aurora/connect.js';
import { quoteBody, summarize, type StatusResponse } from '../src/aurora/oneclick.js';
import { MONAD } from '../src/config.js';
import { limiter } from '../src/http.js';
import { KuruFlow, decodeKuruSwap, encodeKuruSwap, withHex } from '../src/kuru/flow.js';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

type Call = { url: string; init?: RequestInit };
/** Fake fetch: first matching [substring, fixture | {status, body}] wins. Records every call. */
function fakeFetch(routes: [string, unknown, number?][]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = routes.find(([k]) => url.includes(k));
    if (!hit) return new Response('{"error":"no fixture"}', { status: 599 });
    return new Response(JSON.stringify(hit[1]), { status: hit[2] ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const USER = '0x1111111111111111111111111111111111111111';
const VAULT = '0x3333333333333333333333333333333333333333';
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('Kuru Flow calldata', () => {
  for (const name of ['kuru-quote-usdc-ausd', 'kuru-quote-mon-ausd-referrer']) {
    it(`decodes and re-encodes ${name} byte-for-byte`, () => {
      const q = fx(name);
      const d = decodeKuruSwap(q.transaction.calldata);
      expect(d.tokenOut.toLowerCase()).toBe(MONAD.AUSD.toLowerCase());
      expect(d.minOut).toBe(q.minOut);
      expect(encodeKuruSwap(d)).toBe(withHex(q.transaction.calldata).toLowerCase());
    });
  }
  it('picks up the referrer fields', () => {
    const d = decodeKuruSwap(fx('kuru-quote-mon-ausd-referrer').transaction.calldata);
    expect(d.opts[2]).toBe('0x2222222222222222222222222222222222222222');
    expect(d.opts[3]).toBe('10');
    expect(d.amountIn).toBe('100000000000000000000');
  });
});

describe('Intents Connect recipe', () => {
  it('builds valid steps around the {MIN_AMOUNT_OUT} placeholder', () => {
    const swap = decodeKuruSwap(fx('kuru-quote-usdc-ausd').transaction.calldata);
    const steps = depositAndFollowRecipe.buildSteps(
      { intermediary: '0xDACE323d141AfCa01dACeBF00D439ED6FC5Bf7A3', userAddress: USER, amount: '{MIN_AMOUNT_OUT}' },
      { vault: VAULT, swap, depositAmount: swap.minOut },
    );
    expect(steps.length).toBeLessThanOrEqual(30);
    expect(steps.some((s) => s.to === MONAD.USDC)).toBe(true); // destination-token rule
    for (const s of steps) expect(Object.keys(s).sort()).toEqual(['functionSignature', 'parameters', 'to', 'value']);
    expect(steps[1]!.parameters[0]).toEqual([swap.tokenOut, swap.minOut, swap.tokenIn, '{MIN_AMOUNT_OUT}']);
    expect(steps[3]).toMatchObject({ to: VAULT, functionSignature: 'deposit(uint256)', parameters: [swap.minOut] });
  });
});

describe('1Click', () => {
  it('builds the same request we recorded live', () => {
    const rec = fx('oneclick-quote-dry-base').quoteRequest;
    const b = quoteBody({ originAsset: rec.originAsset, amount: rec.amount, refundTo: rec.refundTo, recipient: rec.recipient });
    for (const k of ['dry', 'swapType', 'depositType', 'depositMode', 'destinationAsset', 'slippageTolerance', 'refundType', 'recipientType'] as const)
      expect(b[k]).toEqual(rec[k]);
  });
  it('summarises pending and refunded statuses', () => {
    const s: StatusResponse = fx('oneclick-status-pending');
    expect(summarize(s)).toMatchObject({ phase: 'awaiting_deposit', terminal: false, refunded: null });
    const r = summarize({
      ...s,
      status: 'REFUNDED',
      swapDetails: { ...s.swapDetails, refundedAmount: '5000000', refundedAmountFormatted: '5.0', refundReason: 'slippage' },
    });
    expect(r).toMatchObject({ phase: 'refunded', terminal: true, refunded: '5.0', readyForDeposit: false });
  });
});

describe('HTTP routes', () => {
  const kuruRoutes: [string, unknown][] = [
    // recorded token has long expired; keep it valid so the cache is exercised
    ['/generate-token', { ...fx('kuru-generate-token'), expires_at: Math.floor(Date.now() / 1000) + 86400 }],
    ['ws.kuru.io/api/quote', fx('kuru-quote-usdc-ausd')],
  ];
  const mk = (routes: [string, unknown, number?][], extra = {}) => {
    const f = fakeFetch(routes);
    const app = createApp({ fetch: f.fn, kuru: new KuruFlow({ fetch: f.fn, intervalMs: 0 }), auroraApiKey: '', connectEnabled: false, ...extra });
    return { app, calls: f.calls };
  };

  it('POST /aurora/quote (public 1Click)', async () => {
    const { app, calls } = mk([['1click.chaindefuser.com/v0/quote', fx('oneclick-quote-dry-base')]]);
    const r = await app.request('/aurora/quote', post({ source: 'base:USDC', amount: '5000000', refundTo: USER, recipient: USER }));
    expect(r.status).toBe(200);
    expect((await r.json()).minAmountOut).toBe('4938686');
    expect(JSON.parse(String(calls[0]!.init!.body)).dry).toBe(true);
  });

  it('POST /aurora/deposit-address returns the live deposit address', async () => {
    const { app } = mk([['/v0/quote', fx('oneclick-quote-live-base')]]);
    const r = await app.request('/aurora/deposit-address', post({ source: 'base:USDC', amount: '5000000', refundTo: USER, recipient: USER }));
    expect(await r.json()).toMatchObject({ kind: 'quote', depositAddress: '0x918705de1AD0d5FE184eb0D33B651FF56839498c' });
  });

  it('uses the Aurora host with a key and redacts it from errors', async () => {
    const bad = fx('aurora-quote-bad-key');
    const { app, calls } = mk([['intents-api.aurora.dev/api/quote/', bad.body, bad.status]], { auroraApiKey: 'sekret' });
    const r = await app.request('/aurora/quote', post({ source: 'sol:USDC', amount: '5000000', refundTo: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', recipient: USER }));
    expect(calls[0]!.url).toContain('/api/quote/sekret');
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.upstreamStatus).toBe(404);
    expect(JSON.stringify(j)).not.toContain('sekret');
  });

  it('GET /aurora/status/:id', async () => {
    const { app } = mk([['/v0/status?depositAddress=0x9187', fx('oneclick-status-pending')]]);
    const j = await (await app.request('/aurora/status/0x918705de1AD0d5FE184eb0D33B651FF56839498c')).json();
    expect(j).toMatchObject({ status: 'PENDING_DEPOSIT', phase: 'awaiting_deposit', terminal: false });
  });

  it('rejects bad input with 400', async () => {
    const { app, calls } = mk([]);
    const r = await app.request('/aurora/quote', post({ source: 'base:USDC', amount: '5', refundTo: USER, recipient: 'nope' }));
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('POST /kuru/quote with a vault returns approve + swap + approve + deposit', async () => {
    const { app, calls } = mk(kuruRoutes);
    const j = await (await app.request('/kuru/quote', post({ userAddress: USER, tokenIn: 'USDC', amount: '5000000', vault: VAULT }))).json();
    expect(j.minOut).toBe('4999525');
    expect(j.txs.map((t: { label: string }) => t.label)).toEqual(['approve Kuru Flow', 'swap to AUSD (Kuru Flow)', 'approve vault', 'FollowerVault.deposit']);
    expect(j.txs[1].to).toBe(MONAD.KURU_FLOW_ENTRYPOINT);
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe('Bearer <redacted-jwt>');
  });

  it('caches the Kuru JWT per user', async () => {
    const { app, calls } = mk(kuruRoutes);
    for (let i = 0; i < 2; i++) await app.request('/kuru/quote', post({ userAddress: USER, tokenIn: 'MON', amount: '1000' }));
    expect(calls.filter((c) => c.url.includes('generate-token'))).toHaveLength(1);
  });

  it('POST /socket/deposit-address picks the active route', async () => {
    const { app, calls } = mk([['/v3/swap/quote?', fx('socket-quote-deposit-bsc-usdt')]]);
    const j = await (await app.request('/socket/deposit-address', post({ receiver: USER, amount: '20000000000000000000' }))).json();
    expect(j).toMatchObject({ depositAddress: '0xa9D6fa8F829370Fbd5D9544722be2474Cf1EdDF9', bridge: 'mayan', chainId: 56 });
    expect(calls[0]!.url).toContain('refundAddress=' + USER);
  });

  it('GET /socket/status/:id', async () => {
    const { app } = mk([['/v3/swap/status?quoteId=', fx('socket-status-pending')]]);
    const j = await (await app.request('/socket/status/0x31ef')).json();
    expect(j).toMatchObject({ status: 'PENDING', terminal: false });
  });

  it('Connect proxy: gated, allow-listed, adds x-api-key', async () => {
    const off = mk([]);
    expect((await off.app.request('/aurora/connect/api/v1/executions/0xabc', post({}))).status).toBe(503);
    const on = mk([['intents-connect-alpha-api.aurora.dev/api/v1/executions/', fx('connect-create-no-key').body, 401]], {
      connectEnabled: true,
      connectApiKey: 'ck',
    });
    expect((await on.app.request('/aurora/connect/api/v1/executions/0xabc/submit', post({}))).status).toBe(404);
    const r = await on.app.request('/aurora/connect/api/v1/executions/0xabc/steps', post({ a: 1 }));
    expect(r.status).toBe(401);
    expect((on.calls[0]!.init!.headers as Record<string, string>)['x-api-key']).toBe('ck');
  });

  it('POST /aurora/connect/plan quotes the swap for the intermediary', async () => {
    const { app, calls } = mk([['/intermediary', fx('connect-intermediary')], ...kuruRoutes], { connectEnabled: true });
    const j = await (await app.request('/aurora/connect/plan', post({ wallet: USER, vault: VAULT, expectedUsdc: '5154149' }))).json();
    expect(j.intermediary).toBe('0xDACE323d141AfCa01dACeBF00D439ED6FC5Bf7A3');
    expect(j.params.depositAmount).toBe('4999525');
    const kq = JSON.parse(String(calls.find((c) => c.url.endsWith('/api/quote'))!.init!.body));
    expect(kq).toMatchObject({ userAddress: j.intermediary, amount: '4999524' }); // 3% reserve
  });
});

it('limiter spaces calls', async () => {
  const run = limiter(50);
  const t: number[] = [];
  await Promise.all([1, 2, 3].map(() => run(async () => t.push(Date.now()))));
  expect(t[2]! - t[0]!).toBeGreaterThanOrEqual(95);
});

it('surfaces 1Click "No liquidity" (seen live 11 Oct for every source -> Monad) as 502 with the upstream message', async () => {
  const nl = fx('oneclick-quote-no-liquidity');
  const f = fakeFetch([['/v0/quote', nl.body, nl.status]]);
  const app = createApp({ fetch: f.fn, auroraApiKey: '' });
  const r = await app.request('/aurora/deposit-address', post({ source: 'base:USDC', amount: '5000000', refundTo: USER, recipient: USER }));
  expect(r.status).toBe(502);
  expect((await r.json()).upstream.message).toBe('No liquidity available');
});

it('encodes Kuru V1 order book amounts with the market precisions', async () => {
  const { limitOrderData, marketOrderData, orderBookAbi } = await import('../src/kuru/market.js');
  const { decodeFunctionData } = await import('viem');
  const m = { pricePrecision: 10_000, sizePrecision: 100n };
  expect(decodeFunctionData({ abi: orderBookAbi, data: limitOrderData(m, 'buy', '0.12', '10') }).args).toEqual([1200, 1000n, true]);
  expect(decodeFunctionData({ abi: orderBookAbi, data: marketOrderData(m, 'sell', '2.5') }).args).toEqual([250n, 0n, false, false]);
});
