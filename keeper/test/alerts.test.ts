import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelMessage } from '../src/logic.js';
import { sendChannel } from '../src/alerts.js';

const EX = 'https://testnet.monadexplorer.com';
const LB = '0xB1B08f6A0642c51b48c1916136458A769A1C5208';
const V = '0x38e8ebbd7bd291036a0efe4a6efa3bccd27d74ff';
const TX = '0x' + 'ab'.repeat(32);

describe('channel messages', () => {
  it('breach names the reason, pot and leader link', () => {
    const m = channelMessage({ eventName: 'Breached', address: LB, args: { epoch: 2n, reason: 1, pot: 25_000_000n, capTotal: 200_000_000n }, transactionHash: TX }, EX)!;
    expect(m).toContain('BREACH');
    expect(m).toContain('drawdown');
    expect(m).toContain('25 AUSD');
    expect(m).toContain('/leader/0xb1b08f6a0642c51b48c1916136458a769a1c5208');
    expect(m).toContain(`${EX}/tx/${TX}`);
  });
  it('covers leader created, epoch rolled, slash claimed and new follower', () => {
    expect(channelMessage({ eventName: 'LeaderCreated', address: LB, args: { owner: V, leaderBook: LB, pool: V } }, EX)).toMatch(/^New leader 0xB1B0…5208/);
    expect(channelMessage({ eventName: 'EpochRolled', address: LB, args: { epoch: 3n, unitPrice: 999_498_330_000_000_000n, status: 2 } }, EX)).toContain('epoch 3, unit price 0.9995, status Breached');
    expect(channelMessage({ eventName: 'Claimed', address: LB, args: { epoch: 2n, vault: V, to: V, amount: 29_617n } }, EX)).toContain('claimed 0.03 AUSD');
    expect(channelMessage({ eventName: 'FollowerRegistered', address: LB, args: { vault: V, cap: 200_000_000n, fromEpoch: 1n } }, EX)).toContain('200 AUSD cap');
  });
  it('ignores other events', () => {
    expect(channelMessage({ eventName: 'Checkpoint', address: LB, args: {} }, EX)).toBeNull();
  });
});

describe('sendChannel', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('skips cleanly without token or chat id', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await sendChannel('x', '', '@c')).toBe(false);
    expect(await sendChannel('x', 't', '')).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it('posts sendMessage to the bot API', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
    vi.stubGlobal('fetch', f);
    expect(await sendChannel('hello', 'TOKEN', '@copas_alerts')).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: '@copas_alerts', text: 'hello', disable_web_page_preview: true });
  });
  it('throws on a Telegram error so the tick retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })));
    await expect(sendChannel('x', 'T', '@nope')).rejects.toThrow('chat not found');
  });
});
