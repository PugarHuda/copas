// GET /health · GET /metrics · GET /proof/deny · POST /webhooks/alchemy
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cfg, log } from './config.js';
import { alchemyTxHashes, verifyAlchemySignature } from './logic.js';
import type { Keeper } from './keeper.js';

export function startHttp(k: Keeper) {
  const srv = createServer(async (req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    };
    try {
      const url = req.url?.split('?')[0];
      if (req.method === 'GET' && url === '/health') {
        return json(200, { ok: k.head > 0n && k.head - k.cursor < 300n, lastBlock: k.head.toString(), processedBlock: k.cursor.toString() });
      }
      if (req.method === 'GET' && url === '/metrics') return json(200, k.metrics());
      if (req.method === 'GET' && url === '/proof/deny') {
        try { return json(200, JSON.parse(readFileSync(resolve(cfg.ROOT, 'logs/deny.json'), 'utf8'))); }
        catch { return json(404, { error: 'run pnpm privy:deny-demo first' }); }
      }
      if (req.method === 'POST' && url === '/webhooks/alchemy') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks);
        if (!verifyAlchemySignature(raw, req.headers['x-alchemy-signature'] as string | undefined, cfg.alchemyKey)) return json(401, { error: 'bad signature' });
        const hashes = alchemyTxHashes(JSON.parse(raw.toString('utf8')));
        json(200, { ok: true, txs: hashes.length });
        for (const h of hashes) await k.processReceipt(h).catch((e) => log('warn', 'webhook receipt failed', { h, err: String(e) }));
        return;
      }
      json(404, { error: 'not found' });
    } catch (e) {
      log('error', 'http handler failed', { err: String(e) });
      if (!res.headersSent) json(500, { error: 'internal' });
    }
  });
  srv.listen(cfg.httpPort, () => log('info', 'http listening', { port: cfg.httpPort }));
  return srv;
}
