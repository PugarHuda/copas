// Vercel entry: every path is rewritten here (vercel.json) and served by the same Hono app as src/server.ts.
// ponytail: nothing is CDN-cached; every response is a per-user quote, deposit address or status.
import { createApp } from "../dist/app.js";

const app = createApp();
const handle = (req) => app.fetch(req);
export { handle as GET, handle as POST, handle as OPTIONS };
