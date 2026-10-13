import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { getLang } from "@/lib/i18n/server";
import { TradeApp } from "./TradeApp";

export const metadata: Metadata = {
  title: "Trade",
  description: "Trade Perpl perps from your Mera passkey account with AUSD, inside a mandate a bonded leader would keep.",
};

type SP = Promise<{ m?: string }>;

export default async function TradePage({ searchParams }: { searchParams: SP }) {
  const [{ m }, lang] = await Promise.all([searchParams, getLang()]);
  const id = lang === "id";
  return (
    <>
      <PageHead
        title={id ? "Trade" : "Trade"}
        lede={
          id
            ? "Perp Perpl langsung dari akun passkey Anda, dengan AUSD sebagai margin. Setiap order dicek terhadap mandat Anda dulu, aturan yang sama yang dijaga bond leader Copas."
            : "Perpl perps straight from your passkey account, with AUSD as margin. Every order is checked against your mandate first, the same rules a Copas leader's bond enforces."
        }
      />
      <TradeApp initial={typeof m === "string" ? m.slice(0, 8) : undefined} />
    </>
  );
}
