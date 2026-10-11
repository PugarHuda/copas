import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Header } from "@/components/Header";
import { getLang } from "@/lib/i18n/server";

const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex" });
const plexCond = IBM_Plex_Sans_Condensed({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-plex-cond" });

export const metadata: Metadata = {
  title: { default: "Copas", template: "%s · Copas" },
  description: "Copy trading on Monad where every leader posts a bond. Break the mandate, the bond pays the followers.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const lang = await getLang();
  return (
    <html lang={lang} className={`${plex.variable} ${plexCond.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers lang={lang}>
          <Header />
          <main className="mx-auto max-w-[1320px] px-4 pb-24 pt-8 sm:px-6">{children}</main>
          <footer className="border-t border-line">
            <div className="mx-auto flex max-w-[1320px] flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-xs text-ink-3 sm:px-6">
              <span>Copas · Monad Metropolis 2026</span>
              <span>{lang === "id" ? "Kontrak belum diaudit. Deposit mainnet dibatasi." : "Unaudited contracts. Mainnet deposits are capped."}</span>
              <a className="hover:text-ink-2" href="https://app.perpl.xyz" target="_blank" rel="noreferrer">
                Perpl
              </a>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
