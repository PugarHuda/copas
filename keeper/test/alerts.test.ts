import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelCard, esc, sendChannelCard, type Card } from '../src/alerts.js';

const EX = 'https://testnet.monadexplorer.com';
const APP = 'https://copas-mocha.vercel.app';
const LB = '0xB1B08f6A0642c51b48c1916136458A769A1C5208';
const lb = LB.toLowerCase();
const V = '0x38e8ebbd7bd291036a0efe4a6efa3bccd27d74ff';
const TX = '0x' + 'ab'.repeat(32);
const NOW = 1_760_000_000_000;

describe('channel cards', () => {
  it('breach: reason, epoch, peak vs unit, drawdown vs limit, pot, capacity, explorer link and the four buttons', () => {
    const c = channelCard(
      { eventName: 'Breached', address: LB, args: { epoch: 2n, reason: 1, pot: 25_000_000n, capTotal: 200_000_000n }, transactionHash: TX },
      { checkpoint: { unitPrice: 923_400_000_000_000_000n, peak: 10n ** 18n, ddBps: 766n, leverageHdths: 120n }, mandate: { maxDDbps: 500, maxLeverageHdths: 500 } },
      EX, APP, NOW,
    )!;
    expect(c.photo).toBe(`${APP}/leader/${lb}/opengraph-image?v=${NOW}`);
    expect(c.caption).toContain('<b>BREACH</b>');
    expect(c.caption).toContain('<b>drawdown</b> mandate in epoch 2');
    expect(c.caption).toContain('Unit price 0.923400 vs epoch peak 1.000000');
    expect(c.caption).toContain('Drawdown <b>7.66%</b> vs mandate limit 5.00%');
    expect(c.caption).toContain('<b>25 AUSD</b>');
    expect(c.caption).toContain('Eligible follower capacity: 200 AUSD (pot covers 12.5% of it)');
    expect(c.caption).toContain(`<a href="${EX}/tx/${TX}">`);
    expect(c.buttons).toEqual([
      [{ text: 'Claim', url: `${APP}/me` }, { text: 'Proof', url: `${APP}/proof` }],
      [{ text: 'Leader', url: `${APP}/leader/${lb}` }, { text: 'Breach odds', url: `${APP}/market/${lb}` }],
    ]);
  });
  it('breach without chain reads still carries pot and capacity', () => {
    const c = channelCard({ eventName: 'Breached', address: LB, args: { epoch: 2n, reason: 2, pot: 1_000_000n, capTotal: 0n } }, {}, EX)!;
    expect(c.caption).not.toContain('Unit price');
    expect(c.caption).toContain('(no eligible followers)');
    expect(c.caption).not.toContain('explorer');
  });
  it('epoch roll shows the unit-price change of the epoch when the previous roll is known', () => {
    const ev = { eventName: 'EpochRolled', address: LB, args: { epoch: 3n, unitPrice: 999_498_330_000_000_000n, status: 2 } };
    expect(channelCard(ev, { prevUnit: 10n ** 18n }, EX)!.caption).toContain('Unit price 1.000000 → 0.999498 (<b>-0.05%</b> this epoch)');
    const c = channelCard(ev, { checkpoint: { unitPrice: 0n, peak: 10n ** 18n, ddBps: 5n, leverageHdths: 0n } }, EX)!;
    expect(c.caption).toContain('Unit price at close: 0.999498');
    expect(c.caption).toContain('Epoch high 1.000000, closed 0.05% below it');
    expect(c.caption).toContain('Epoch 3 is open, status <b>Breached</b>');
  });
  it('new follower shows ratio and caps', () => {
    const c = channelCard({ eventName: 'FollowerRegistered', address: LB, args: { vault: V, cap: 200_000_000n, fromEpoch: 4n } }, { follow: { ratioBps: 5000, maxLeverageHdths: 300, stopLossBps: 1000 } }, EX)!;
    expect(c.caption).toContain('Ratio 50% of the leader\'s size · max leverage 3.0x · stop-loss 10.00%');
    expect(c.caption).toContain('Cap 200 AUSD');
    expect(c.caption).toContain('eligible from epoch 4');
  });
  it('covers leader created and slash claimed, ignores other events', () => {
    expect(channelCard({ eventName: 'LeaderCreated', address: V, args: { owner: V, leaderBook: LB } }, { mandate: { maxDDbps: 1500, maxLeverageHdths: 500, epochLen: 86400n } }, EX)!.caption)
      .toContain('max drawdown 15.00% · max leverage 5.0x · 24h epochs');
    expect(channelCard({ eventName: 'Claimed', address: LB, args: { epoch: 2n, vault: V, amount: 29_617n } }, {}, EX)!.caption).toContain('claimed <b>0.03 AUSD</b>');
    expect(channelCard({ eventName: 'Checkpoint', address: LB, args: {} }, {}, EX)).toBeNull();
  });
  it('escapes HTML', () => {
    expect(esc('<b>&"')).toBe('&lt;b&gt;&amp;"');
    expect(channelCard({ eventName: 'EpochRolled', address: LB, args: { epoch: 2n, unitPrice: 0n, status: '<x>' } }, {}, EX)!.caption).toContain('&lt;x&gt;');
  });
});

describe('sendChannelCard', () => {
  afterEach(() => vi.unstubAllGlobals());
  const card: Card = { photo: 'https://x/img?v=1', caption: '<b>hi</b>', buttons: [[{ text: 'Leader', url: 'https://x' }]] };
  it('skips cleanly without token or chat id', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await sendChannelCard(card, '', '@c')).toBeNull();
    expect(await sendChannelCard(card, 't', '')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it('posts sendPhoto with HTML caption and inline keyboard', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })));
    vi.stubGlobal('fetch', f);
    expect(await sendChannelCard(card, 'TOKEN', '-100')).toEqual({ message_id: 7 });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(card.photo); // warms the OG render first
    const [url, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendPhoto');
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: '-100', parse_mode: 'HTML', photo: card.photo, caption: card.caption, reply_markup: { inline_keyboard: card.buttons },
    });
  });
  it('falls back to a text message when the photo fails', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response('png'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'Bad Request: wrong file identifier/HTTP URL specified' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 8 } })));
    vi.stubGlobal('fetch', f);
    expect(await sendChannelCard(card, 'T', '-100')).toEqual({ message_id: 8 });
    const [url, init] = f.mock.calls[2] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botT/sendMessage');
    expect(JSON.parse(String(init.body)).text).toBe(card.caption);
  });
  it('throws when Telegram refuses both, so the tick retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })));
    await expect(sendChannelCard(card, 'T', '@nope')).rejects.toThrow('chat not found');
  });
});
