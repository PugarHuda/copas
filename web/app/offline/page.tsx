import type { Metadata } from "next";

export const metadata: Metadata = { title: "Offline" };

/** Served by public/sw.js when a navigation fails. Static on purpose: no prices or balances, those are never cached. */
export default function Offline() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="font-cond text-3xl font-semibold">You are offline</h1>
      <p className="mt-3 text-ink-2">
        Copas never shows cached prices, balances or positions. Reconnect and your passkey account, AUSD balance and Perpl positions load fresh from Monad.
      </p>
      <a href="/trade" className="mt-6 inline-flex rounded-md bg-gold px-4 py-2 text-sm font-medium text-gold-ink">
        Try again
      </a>
    </div>
  );
}
