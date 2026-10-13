"use client";
import { Suspense, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { MeraProvider } from "@/lib/mera/MeraProvider";
import { I18nProvider } from "@/lib/i18n/client";
import { ReferralCapture } from "@/lib/copas/referral";
import type { Lang } from "@/lib/i18n/dict";
import { PwaRegister } from "./PwaRegister";

export function Providers({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <I18nProvider lang={lang}>
          <MeraProvider>
            <Suspense fallback={null}>
              <ReferralCapture />
            </Suspense>
            <PwaRegister />
            {children}
          </MeraProvider>
        </I18nProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
