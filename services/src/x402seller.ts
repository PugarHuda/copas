/**
 * D4 seller side of x402: `GET /x402/report/:addr` costs X402_PRICE_USDC (default 0.01) testnet USDC on Monad
 * (eip155:10143). The Monad x402 facilitator (x402-facilitator.molandak.org, listed in docs.monad.xyz) verifies the
 * EIP-3009 authorization and settles it onchain, paying the gas; the settlement tx comes back in `payment-response`.
 * Testnet USDC is not in @x402/evm's default asset table, so the price is an explicit AssetAmount with its EIP-712
 * domain ("USDC", "2"). Off unless X402_PAY_TO is set.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { env, isAddress } from "./util.js";

export const X402_TESTNET = "eip155:10143" as const;
export const TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
export const FACILITATOR = "https://x402-facilitator.molandak.org";

export function x402Seller() {
  const payTo = env("X402_PAY_TO");
  if (!payTo || !isAddress(payTo)) return null;
  const usdc = Number(env("X402_PRICE_USDC") ?? "0.01");
  const amount = String(Math.round(usdc * 1e6));
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env("X402_FACILITATOR_URL") ?? FACILITATOR })).register(X402_TESTNET, new ExactEvmScheme());
  const terms = { network: X402_TESTNET, asset: TESTNET_USDC, amount, usdc, payTo, facilitator: env("X402_FACILITATOR_URL") ?? FACILITATOR };
  const middleware = paymentMiddleware(
    {
      "GET /x402/report/*": {
        accepts: [{ scheme: "exact", network: X402_TESTNET, payTo, price: { asset: TESTNET_USDC, amount, extra: { name: "USDC", version: "2" } }, maxTimeoutSeconds: 120 }],
        description: "Copas leader report: signed Perpl track record + LLM risk analysis with an EIP-191 receipt",
        mimeType: "application/json",
      },
    },
    server,
  );
  return { middleware, terms };
}
