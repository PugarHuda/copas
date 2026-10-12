// Pays for GET /x402/report/:addr with Monad testnet USDC and prints the facilitator's settlement tx.
// X402_PAYER_KEY=0x.. tsx scripts/x402-pay.ts [base url] [leader]   (payer needs testnet USDC, no MON: the facilitator pays gas)
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const [base = "https://copas-services.vercel.app", leader = "0xc8d79f44912a9f55c6faf819283efcea9661d1dc"] = process.argv.slice(2);
const key = process.env.X402_PAYER_KEY as `0x${string}` | undefined;
if (!key) throw new Error("set X402_PAYER_KEY (a key holding testnet USDC 0x534b…43A3 on Monad testnet)");
const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(key), networks: ["eip155:10143"] });
const r = await wrapFetchWithPayment(fetch, client)(`${base}/x402/report/${leader}`);
const pr = r.headers.get("payment-response");
console.log(JSON.stringify({ status: r.status, payer: privateKeyToAccount(key).address, settlement: pr ? decodePaymentResponseHeader(pr) : null, error: r.ok ? undefined : r.headers.get("payment-required") ? JSON.parse(Buffer.from(r.headers.get("payment-required")!, "base64").toString()).error : (await r.text()).slice(0, 500) }, null, 2));
if (r.ok) console.log("explorer:", `https://testnet.monadexplorer.com/tx/${(decodePaymentResponseHeader(pr!) as any)?.transaction}`);
