"use client";
import { createContext, useContext } from "react";
import { useRouter } from "next/navigation";
import { LANG_COOKIE, dicts, type DictKey, type Lang } from "./dict";

const LangCtx = createContext<Lang>("id");

export function I18nProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return <LangCtx.Provider value={lang}>{children}</LangCtx.Provider>;
}

export function useT() {
  const lang = useContext(LangCtx);
  return { lang, t: (k: DictKey) => dicts[lang][k] };
}

/** Pick between inline ID/EN strings for one-off copy that does not deserve a dictionary key. */
export function useL() {
  const lang = useContext(LangCtx);
  return (idText: string, enText: string) => (lang === "id" ? idText : enText);
}

export function LangToggle() {
  const { lang } = useT();
  const router = useRouter();
  const set = (l: Lang) => {
    document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };
  return (
    <div role="group" aria-label="Language" className="flex rounded-md border border-line text-xs">
      {(["id", "en"] as const).map((l) => (
        <button
          key={l}
          onClick={() => set(l)}
          aria-pressed={lang === l}
          className={`px-2 py-1 ${lang === l ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2"}`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
