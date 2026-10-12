import Link from "next/link";
import type { Metadata } from "next";
import { btn } from "@/components/ui";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="py-16 text-center sm:py-24">
      <p className="micro text-ink-3">404</p>
      <div className="bracket mx-auto mt-3 inline-block py-2">
        <h1 className="display text-[clamp(44px,8vw,104px)] text-white">Not found</h1>
      </div>
      <p className="mx-auto mt-6 max-w-md text-[15px] leading-relaxed text-ink-2">
        No leader, account or page lives at this link. Check the address: leaders and wallets are 40-character 0x addresses, accounts are numeric Perpl IDs.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link href="/#leaders" className={btn.primary}>
          See leaders
        </Link>
        <Link href="/analytics" className={btn.ghost}>
          Perpl analytics
        </Link>
      </div>
    </div>
  );
}
