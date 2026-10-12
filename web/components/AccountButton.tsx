"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { useT } from "@/lib/i18n/client";
import { short } from "@/lib/format";
import { copasChain } from "@/lib/chains";
import { btn } from "./ui";

export function useMinutesLeft(expiresAt?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 60_000)) : 0;
}

const FAUCET_ERR: Record<string, string> = {
  cooldown: "Already sent in the last hour. Try again later.",
  "faucet-off": "The testnet faucet is not configured on this deployment.",
  "bad-address": "Sign in again; no valid address to fund.",
  network: "Network error. Try again.",
};

/** Telegram's in-app webview / Mini App (no WebAuthn there): its JS bridge, the Mini App launch hash, or a flag from earlier in this tab. */
function useInTelegram() {
  const [tg, setTg] = useState(false);
  useEffect(() => {
    try {
      const hit = "TelegramWebviewProxy" in window || location.hash.includes("tgWebApp") || sessionStorage.getItem("copas:tg") === "1";
      if (hit) sessionStorage.setItem("copas:tg", "1");
      setTg(hit);
    } catch {
      /* storage blocked: detection by bridge/hash only */
    }
  }, []);
  return tg;
}

export function AccountButton() {
  const { status, address, expiresAt, error, create, signIn, signOut, cancel, persona } = useMeraSession();
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const left = useMinutesLeft(expiresAt);
  const inTelegram = useInTelegram();
  const [drip, setDrip] = useState<string>();
  const getTestFunds = async () => {
    setDrip("…");
    const r = await fetch("/api/faucet", { method: "POST", body: JSON.stringify({ address }) }).then((x) => x.json()).catch(() => ({ error: "network" }));
    setDrip(r.error ? `✕ ${FAUCET_ERR[r.error] ?? "Faucet transaction failed. Try again later."}` : lang === "id" ? "✓ MON + AUSD terkirim" : "✓ MON + AUSD sent");
  };

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const quiet = (p: Promise<void>) => p.catch(() => undefined); // error is surfaced through context

  if (status === "signed-in" && address)
    return (
      <div ref={ref} className="relative">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="num flex items-center gap-2 rounded-md border border-line-strong px-3 py-1.5 text-sm">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-up" />
          {short(address)}
          {persona === 1 && <span className="rounded bg-gold/15 px-1 text-[10px] uppercase tracking-wide text-gold-2">private</span>}
        </button>
        {open && (
          <div className="absolute right-0 mt-2 w-72 rounded-lg border border-line bg-surface p-3 text-sm shadow-xl shadow-black/40">
            <div className="num break-all text-ink-2">{address}</div>
            <div className="mt-2 text-xs text-ink-3">
              {t("auth.session")}: <span className="num text-ink-2">{left}</span> {t("auth.sessionLeft")}
            </div>
            {copasChain.testnet && (
              <button className={btn.ghost + " mt-3 w-full py-1.5"} onClick={getTestFunds} disabled={drip === "…"}>
                {drip ?? (lang === "id" ? "Ambil MON + AUSD testnet" : "Get testnet MON + AUSD")}
              </button>
            )}
            <div className="mt-3 flex gap-2">
              <Link href="/me" className={btn.ghost + " flex-1 py-1.5"} onClick={() => setOpen(false)}>
                {t("nav.me")}
              </Link>
              <button className={btn.ghost + " flex-1 py-1.5"} onClick={() => (signOut(), setOpen(false))}>
                {t("auth.signout")}
              </button>
            </div>
          </div>
        )}
      </div>
    );

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className={btn.primary + " py-1.5"} disabled={status === "working"}>
        {status === "working" ? t("auth.working") : t("auth.signin")}
      </button>
      {status === "working" && (
        <button onClick={cancel} className={btn.ghost + " py-1.5"}>
          {lang === "id" ? "Batal" : "Cancel"}
        </button>
      )}
      {open && status !== "working" && (
        <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-4 text-sm shadow-xl shadow-black/40">
          {status === "expired" && <p className="mb-3 text-xs text-warn">{t("auth.sessionExpired")}</p>}
          <p className="text-ink-2">
            {lang === "id"
              ? "Akun Copas adalah passkey kamu. Tidak ada seed phrase, tidak ada kunci di server."
              : "Your Copas account is your passkey. No seed phrase, no key on any server."}
          </p>
          {inTelegram ? (
            <div className="mt-3 grid gap-2">
              <p className="text-xs text-warn">Passkeys don&apos;t work inside Telegram. Open Copas in your browser to sign in; everything else works here.</p>
              <a className={btn.primary + " text-center"} href={typeof window === "undefined" ? "/" : location.href.split("#")[0]} target="_blank" rel="noreferrer">
                Open in browser to sign in
              </a>
            </div>
          ) : (
            <div className="mt-3 grid gap-2">
              <button className={btn.primary} onClick={() => quiet(signIn())}>
                {t("auth.signin")}
              </button>
              <button className={btn.ghost} onClick={() => quiet(create())}>
                {t("auth.create")}
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-xs leading-relaxed text-down">
              {error.message[lang]}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
