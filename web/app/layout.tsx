import type { Metadata } from "next";
import { Barlow_Condensed, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Header } from "@/components/Header";
import { getLang } from "@/lib/i18n/server";

const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex" });
const display = Barlow_Condensed({ subsets: ["latin"], weight: ["300", "400", "500", "600"], variable: "--font-display" });

export const metadata: Metadata = {
  title: { default: "Copas", template: "%s · Copas" },
  description: "Copy trading on Monad where every leader posts a bond. Break the mandate, the bond pays the followers.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const lang = await getLang();
  return (
    <html lang={lang} className={`${plex.variable} ${display.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers lang={lang}>
          <Header />
          <main className="mx-auto max-w-[1320px] px-4 pb-24 pt-8 sm:px-6">{children}</main>
          <footer className="mx-2 mb-2 overflow-hidden rounded-[22px] border-[6px] border-black bg-[#111214] sm:mx-3">
            <div className="grid gap-8 px-5 pt-10 sm:grid-cols-4 sm:px-8">
              <div>
                <p className="micro text-ink-3">{lang === "id" ? "Jaringan" : "Network"}</p>
                <p className="mt-2 text-sm text-ink-2">Monad testnet 10143</p>
                <p className="text-sm text-ink-2">Perpl Exchange</p>
              </div>
              <div>
                <p className="micro text-ink-3">{lang === "id" ? "Bukti" : "Proof"}</p>
                <a className="mt-1.5 block py-0.5 text-sm text-ink-2 hover:text-ink" href="/proof">
                  {lang === "id" ? "Breach & potongan" : "Breaches & slashes"}
                </a>
                <a className="block py-0.5 text-sm text-ink-2 hover:text-ink" href="https://github.com/PugarHuda/copas" target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </div>
              <div>
                <p className="micro text-ink-3">{lang === "id" ? "Data" : "Data"}</p>
                <a className="mt-1.5 block py-0.5 text-sm text-ink-2 hover:text-ink" href="/analytics">
                  {lang === "id" ? "Analitik Perpl" : "Perpl analytics"}
                </a>
                <a className="block py-0.5 text-sm text-ink-2 hover:text-ink" href="https://app.perpl.xyz" target="_blank" rel="noreferrer">
                  Perpl
                </a>
              </div>
              <div>
                <p className="micro text-ink-3">{lang === "id" ? "Catatan" : "Note"}</p>
                <p className="mt-2 text-sm text-ink-2">{lang === "id" ? "Kontrak belum diaudit. Deposit mainnet dibatasi." : "Unaudited contracts. Mainnet deposits are capped."}</p>
              </div>
            </div>
            <div className="flex items-end justify-between gap-4 px-5 sm:px-8">
              <p className="micro mb-4 text-ink-3">Monad Metropolis 2026</p>
              <p aria-hidden className="display select-none text-[26vw] leading-[0.8] tracking-[-0.03em] text-white sm:text-[180px]">
                copas
              </p>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
