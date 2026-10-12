import { loadDeployments, log } from './config.js';
import { makeSigner } from './signer.js';
import { Keeper } from './keeper.js';
import { startHttp } from './http.js';

process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', { err: String(e) }));

try {
  const dep = loadDeployments();
  const signer = await makeSigner();
  const keeper = new Keeper(dep, signer);
  if (process.argv.includes('--once')) process.exit(await keeper.tick()); // `pnpm tick`: one pass, then exit
  startHttp(keeper);
  await keeper.start();
} catch (e: any) {
  log('error', 'fatal startup error', { err: e?.message ?? String(e) });
  process.exit(1);
}
