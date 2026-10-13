"use client";
import { useState } from "react";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { useT } from "@/lib/i18n/client";
import { btn } from "./ui";

/** Second onboarding path: email OTP -> Dynamic embedded wallet on Monad testnet (works where passkeys don't, e.g. Telegram). */
export function DynamicEmail() {
  const { dynamic } = useMeraSession();
  const { lang } = useT();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID) return null;
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch {
      /* surfaced through the session error */
    } finally {
      setBusy(false);
    }
  };
  const input = "w-full rounded-md border border-line-strong bg-bg px-2 py-1.5 text-sm";
  return (
    <form
      className="mt-4 grid gap-2 border-t border-line pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sent) run(async () => (await dynamic.sendCode(email.trim()), setSent(true)));
        else run(() => dynamic.verifyCode(code.trim()));
      }}
    >
      <p className="text-xs text-ink-3">
        {lang === "id" ? "Atau masuk dengan email: wallet tertanam Dynamic (MPC), tanpa seed phrase." : "Or use email: a Dynamic embedded (MPC) wallet, no seed phrase."}
      </p>
      {!sent ? (
        <label className="grid gap-1 text-xs text-ink-2">
          Email
          <input className={input} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      ) : (
        <label className="grid gap-1 text-xs text-ink-2">
          {lang === "id" ? `Kode dari ${email}` : `Code sent to ${email}`}
          <input className={input + " num"} inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
      )}
      <button type="submit" className={btn.ghost} disabled={busy}>
        {busy ? "…" : !sent ? (lang === "id" ? "Kirim kode" : "Email me a code") : lang === "id" ? "Masuk" : "Sign in"}
      </button>
    </form>
  );
}
