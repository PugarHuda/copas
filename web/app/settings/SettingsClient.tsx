"use client";
import { useEffect, useState } from "react";
import { useL, useT } from "@/lib/i18n/client";
import { SESSION_TTL_MS, useMeraSession } from "@/lib/mera/MeraProvider";
import { useMinutesLeft } from "@/components/AccountButton";
import { Panel, Pill, btn } from "@/components/ui";

// sessionStorage survives the localStorage wipe + reload, so the test can compare addresses afterwards.
const EXPECT = "copas.stateless.expect";
const CLEARED = "copas.cleared";

export function SettingsClient() {
  const { t, lang } = useT();
  const L = useL();
  const { status, address, expiresAt, error, supported, create, signIn, signOut } = useMeraSession();
  const left = useMinutesLeft(status === "signed-in" ? expiresAt : undefined);
  const [expect, setExpect] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const quiet = (p: Promise<void>) => p.catch(() => undefined);

  useEffect(() => {
    try {
      setExpect(sessionStorage.getItem(EXPECT));
      setCleared(!!sessionStorage.getItem(CLEARED));
      sessionStorage.removeItem(CLEARED);
    } catch {
      /* storage blocked */
    }
  }, []);

  function clearLocal() {
    try {
      if (address) sessionStorage.setItem(EXPECT, address);
      sessionStorage.setItem(CLEARED, "1");
      Object.keys(localStorage)
        .filter((k) => k.startsWith("copas."))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* storage blocked: nothing stored anyway */
    }
    signOut();
    location.reload();
  }

  const match = expect && status === "signed-in" && address ? expect.toLowerCase() === address.toLowerCase() : null;

  return (
    <div className="space-y-6">
      <Panel title={t("settings.account")} aside={status === "signed-in" ? <Pill tone="up">{L("masuk", "signed in")}</Pill> : <Pill>{L("belum masuk", "signed out")}</Pill>}>
        {supported === false && (
          <p role="alert" className="mb-3 text-sm text-warn">
            {L("Browser ini tidak mendukung passkey atau halaman tidak dibuka lewat HTTPS/localhost.", "This browser has no passkey support, or the page is not served over HTTPS/localhost.")}
          </p>
        )}
        {address && (
          <div className="mb-3">
            <div className="text-xs text-ink-3">{status === "signed-in" ? L("Alamat", "Address") : L("Terakhir dipakai di perangkat ini", "Last used on this device")}</div>
            <div className="num break-all text-sm">{address}</div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {status === "signed-in" ? (
            <button className={btn.ghost} onClick={signOut}>
              {t("auth.signout")}
            </button>
          ) : (
            <>
              <button className={btn.primary} disabled={status === "working"} onClick={() => quiet(signIn())}>
                {status === "working" ? t("auth.working") : t("auth.signin")}
              </button>
              <button className={btn.ghost} disabled={status === "working"} onClick={() => quiet(create())}>
                {t("auth.create")}
              </button>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm leading-relaxed text-down">
            {error.message[lang]}
          </p>
        )}
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          {L(
            "Akun diturunkan dari output PRF passkey. Di Chrome, passkey yang disimpan di profil lokal sering tidak mendukung PRF. Pakai passkey tersinkron: Google Password Manager, iCloud Keychain, 1Password, atau Windows Hello.",
            "Your account is derived from the passkey's PRF output. On Chrome, passkeys saved to a local profile often lack PRF. Use a synced passkey: Google Password Manager, iCloud Keychain, 1Password or Windows Hello.",
          )}
        </p>
      </Panel>

      <Panel title={t("settings.session")}>
        <p className="text-sm leading-relaxed text-ink-2">{t("settings.sessionBody")}</p>
        <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-ink-3">{L("Durasi sesi", "Session length")}</dt>
          <dd className="num">{SESSION_TTL_MS / 60_000} min</dd>
          <dt className="text-ink-3">{L("Sisa", "Remaining")}</dt>
          <dd className="num">{status === "signed-in" ? `${left} ${t("auth.sessionLeft")}` : status === "expired" ? L("kedaluwarsa", "expired") : "–"}</dd>
        </dl>
        <p className="mt-3 text-xs text-ink-3">{L("Kunci sesi hanya ada di memori tab ini dan hilang saat kamu keluar, menutup tab, atau sesi habis.", "The session key lives only in this tab's memory and is gone when you sign out, close the tab, or the session ends.")}</p>
      </Panel>

      <Panel title={t("settings.stateless")}>
        <p className="text-sm leading-relaxed text-ink-2">{t("settings.statelessBody")}</p>
        {match !== null && (
          <p role="status" className={`mt-3 text-sm ${match ? "text-up" : "text-down"}`}>
            {match
              ? L("Lulus: alamat setelah masuk ulang sama persis dengan sebelum data dihapus.", "Passed: the address after signing in again matches the one before clearing.")
              : L(`Alamat berbeda dari sebelumnya (${expect}). Kamu mungkin memilih passkey lain.`, `Address differs from before (${expect}). You may have picked a different passkey.`)}
          </p>
        )}
        {expect && match === null && (
          <p className="num mt-3 text-xs text-ink-3">
            {L("Menunggu masuk ulang. Alamat sebelumnya:", "Waiting for sign-in. Previous address:")} {expect}
          </p>
        )}
        <button className={btn.ghost + " mt-4"} onClick={clearLocal}>
          {t("settings.clear")}
        </button>
        {cleared && (
          <p role="status" className="mt-2 text-xs text-up">
            ✓ {L("Data lokal Copas dihapus dan kamu sudah keluar.", "Local Copas data cleared and you are signed out.")}
          </p>
        )}
      </Panel>

    </div>
  );
}
