"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { AccountButton } from "./AccountButton";

export function Header() {
  const { t } = useT();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const nav = [
    { href: "/", label: t("nav.leaders"), match: (p: string) => p === "/" || p.startsWith("/leader") || p.startsWith("/follow") },
    { href: "/seasons", label: "Seasons", match: (p: string) => p.startsWith("/seasons") },
    { href: "/analytics", label: t("nav.analytics"), match: (p: string) => p.startsWith("/analytics") },
    { href: "/saved", label: "Reality check", match: (p: string) => p.startsWith("/saved") },
    { href: "/me", label: t("nav.me"), match: (p: string) => p.startsWith("/me") },
    { href: "/become-leader", label: t("nav.becomeLeader"), match: (p: string) => p.startsWith("/become-leader") },
    { href: "/underwrite", label: t("nav.underwrite"), match: (p: string) => p.startsWith("/underwrite") || p.startsWith("/market") },
    { href: "/proof", label: t("nav.proof"), match: (p: string) => p.startsWith("/proof") },
  ];
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2" aria-label="Copas home">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-gold" />
          <span className="display text-[26px] tracking-tight">copas</span>
        </Link>
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={n.match(path) ? "page" : undefined}
              className={`micro rounded-full px-3 py-1.5 font-medium ${n.match(path) ? "bg-ink text-bg" : "text-ink-3 hover:text-ink"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/settings" className="hidden rounded px-2 py-1.5 text-sm text-ink-3 hover:text-ink-2 sm:block">
            {t("nav.settings")}
          </Link>
          <AccountButton />
          <button className="rounded border border-line px-2 py-1 text-sm lg:hidden" aria-expanded={open} aria-controls="mnav" onClick={() => setOpen(!open)}>
            Menu
          </button>
        </div>
      </div>
      {open && (
        <nav id="mnav" className="border-t border-line px-4 py-2 lg:hidden" aria-label="Mobile">
          {[...nav, { href: "/settings", label: t("nav.settings"), match: (p: string) => p === "/settings" }].map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className={`block py-2 text-sm ${n.match(path) ? "text-ink" : "text-ink-2"}`}>
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
