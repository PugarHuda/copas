"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type Secp256k1SigningSession,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import type { LocalAccount } from "viem";
import { sessionFromPrf, type Persona } from "./derive";

/** E2: prompt-free window for small actions. */
export const SESSION_TTL_MS = 30 * 60 * 1000;
/** A passkey prompt that neither resolves nor rejects frees the UI after this long. */
const PASSKEY_TIMEOUT_MS = 90_000;

/**
 * Action risk classes from SPEC E2.
 * small: sync, checkpoint, tightening own limits -> signs inside a live session.
 * risky: withdraw, follow new leader, raising limits, postBond, requestUnbond -> always re-prompts the passkey.
 */
export type ActionRisk = "small" | "risky";

// Convenience hint only. Losing it changes nothing: sign-in works from the passkey alone.
const HINT_KEY = "copas.mera.hint";
type Hint = { credential: PasskeyCredentialMetadata; address: `0x${string}`; persona?: Persona };

type Status = "signed-out" | "working" | "signed-in" | "expired";

type MeraState = {
  status: Status;
  address?: `0x${string}`;
  expiresAt?: number;
  error?: MeraUiError;
  supported: boolean | undefined;
  create: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => void;
  /** Abandons a pending passkey prompt so the UI is not stuck in "working". */
  cancel: () => void;
  /** Returns a viem account allowed to sign an action of the given risk. Re-prompts when required. */
  authorize: (risk: ActionRisk) => Promise<LocalAccount>;
  /** E4: 0 = main account, 1 = private follower identity (same passkey, unlinkable address). */
  persona: Persona;
  /** Switches identity with one passkey prompt; the session restarts on the other address. */
  switchPersona: (p: Persona) => Promise<void>;
  /** "Many Keys": PRF output of the same passkey under another 32-byte salt. Caller owns (and should wipe) the bytes. */
  prf: (salt: Uint8Array) => Promise<Uint8Array>;
};

export type MeraUiError = { code: string; message: { id: string; en: string } };

const Ctx = createContext<MeraState | null>(null);

function rpId() {
  return process.env.NEXT_PUBLIC_MERA_RP_ID || window.location.hostname;
}

function readHint(): Hint | undefined {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    return raw ? (JSON.parse(raw) as Hint) : undefined;
  } catch {
    return undefined;
  }
}
function writeHint(h: Hint) {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify(h));
  } catch {
    /* storage blocked: fine, passkey is the source of truth */
  }
}

export function toUiError(e: unknown): MeraUiError {
  const code = isMeraError(e) ? e.code : ((e as { code?: string })?.code ?? "UNKNOWN");
  if (code === "TIMEOUT" || code === "CANCELLED")
    return {
      code,
      message: {
        id: code === "TIMEOUT" ? "Passkey tidak merespons dalam 90 detik. Coba lagi." : "Masuk dibatalkan.",
        en: code === "TIMEOUT" ? "The passkey prompt did not respond within 90 seconds. Try again." : "Sign-in cancelled.",
      },
    };
  if (code === "PRF_UNAVAILABLE")
    return {
      code,
      message: {
        id: "Passkey ini tidak mendukung PRF, jadi akun tidak bisa diturunkan. Di Chrome, passkey yang disimpan di profil lokal sering gagal. Pakai passkey yang tersinkron: Google Password Manager, iCloud Keychain, 1Password, atau Windows Hello.",
        en: "This passkey does not support PRF, so no account can be derived from it. On Chrome, passkeys saved to a local profile often fail. Use a synced passkey: Google Password Manager, iCloud Keychain, 1Password or Windows Hello.",
      },
    };
  if (code === "PASSKEY_OPERATION_FAILED")
    return {
      code,
      message: {
        id: "Passkey dibatalkan atau tidak tersedia di browser ini. Coba lagi, atau pilih passkey lain.",
        en: "The passkey prompt was cancelled or is unavailable in this browser. Try again or choose another passkey.",
      },
    };
  if (code === "CRYPTO_UNAVAILABLE")
    return {
      code,
      message: {
        id: "Browser ini tidak menyediakan WebCrypto. Buka Copas lewat HTTPS atau localhost.",
        en: "This browser does not expose WebCrypto. Open Copas over HTTPS or localhost.",
      },
    };
  if (code === "ADDRESS_MISMATCH")
    return {
      code,
      message: {
        id: "Passkey yang dipakai menghasilkan alamat lain. Gunakan passkey yang sama dengan sesi ini.",
        en: "That passkey derives a different address. Use the passkey this session was created with.",
      },
    };
  return {
    code,
    message: { id: "Gagal masuk dengan passkey.", en: "Passkey sign-in failed." },
  };
}

export function MeraProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("signed-out");
  const [address, setAddress] = useState<`0x${string}`>();
  const [expiresAt, setExpiresAt] = useState<number>();
  const [error, setError] = useState<MeraUiError>();
  const [supported, setSupported] = useState<boolean>();
  const sessionRef = useRef<Secp256k1SigningSession | null>(null);
  const accountRef = useRef<LocalAccount | null>(null);
  const credRef = useRef<PasskeyCredentialMetadata | undefined>(undefined);
  const [persona, setPersona] = useState<Persona>(0);
  const personaRef = useRef<Persona>(0);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && !!window.PublicKeyCredential && window.isSecureContext);
    const h = readHint();
    if (h) {
      credRef.current = h.credential;
      personaRef.current = h.persona ?? 0;
      setPersona(personaRef.current);
      setAddress(h.address); // shown as "last used", not signed in
    }
  }, []);

  const endSession = useCallback(() => {
    sessionRef.current?.end();
    sessionRef.current = null;
    accountRef.current = null;
  }, []);

  // Expire the in-memory key when TTL passes.
  useEffect(() => {
    if (!expiresAt) return;
    const id = setTimeout(() => {
      endSession();
      setStatus("expired");
    }, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(id);
  }, [expiresAt, endSession]);

  useEffect(() => endSession, [endSession]);

  const start = useCallback(
    async (prfOutput: Uint8Array, credential: PasskeyCredentialMetadata, expect?: `0x${string}`) => {
      const { session, address: addr } = await sessionFromPrf(prfOutput, personaRef.current);
      if (expect && expect.toLowerCase() !== addr.toLowerCase()) {
        session.end();
        throw Object.assign(new Error("address mismatch"), { code: "ADDRESS_MISMATCH" });
      }
      endSession();
      sessionRef.current = session;
      accountRef.current = toViemAccount(session);
      credRef.current = credential;
      writeHint({ credential, address: addr, persona: personaRef.current });
      setAddress(addr);
      setExpiresAt(Date.now() + SESSION_TTL_MS);
      setStatus("signed-in");
      return accountRef.current;
    },
    [endSession],
  );

  const abortRef = useRef<((e: Error) => void) | undefined>(undefined);
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    setError(undefined);
    setStatus("working");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (code: string) => Object.assign(new Error(code.toLowerCase()), { code });
    try {
      // ponytail: mera takes no AbortSignal, so this only frees the UI; the browser prompt closes on its own WebAuthn `timeout`
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          abortRef.current = reject;
          timer = setTimeout(() => reject(fail("TIMEOUT")), PASSKEY_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      setError(toUiError(e));
      setStatus(sessionRef.current ? "signed-in" : "signed-out");
      throw e;
    } finally {
      clearTimeout(timer);
      abortRef.current = undefined;
    }
  }, []);
  const cancel = useCallback(() => abortRef.current?.(Object.assign(new Error("cancelled"), { code: "CANCELLED" })), []);

  const create = useCallback(
    () =>
      run(async () => {
        personaRef.current = 0; // a new passkey starts on its main account
        setPersona(0);
        const res = await createPasskeyWithPrfOutput({
          rp: { id: rpId(), name: "Copas" },
          user: { name: `copas-${new Date().toISOString().slice(0, 10)}`, displayName: "Copas account" },
          timeout: PASSKEY_TIMEOUT_MS,
        });
        await start(res.prfOutput, { credentialId: res.credentialId, transports: res.transports });
      }),
    [run, start],
  );

  // Single ceremony: one discoverable assertion -> PRF -> key -> session.
  const signIn = useCallback(
    () =>
      run(async () => {
        const res = await getPasskeyPrfOutput({ rpId: rpId(), timeout: PASSKEY_TIMEOUT_MS });
        await start(res.prfOutput, { credentialId: res.credentialId });
      }),
    [run, start],
  );

  const signOut = useCallback(() => {
    endSession();
    setExpiresAt(undefined);
    setStatus("signed-out");
  }, [endSession]);

  const authorize = useCallback(
    async (risk: ActionRisk): Promise<LocalAccount> => {
      const live = sessionRef.current && accountRef.current && expiresAt && Date.now() < expiresAt;
      if (risk === "small" && live) return accountRef.current!;
      // Risky (or no live session): fresh user-verified ceremony, must yield the same address.
      return run(async () => {
        const res = await getPasskeyPrfOutput({ rpId: rpId(), credential: credRef.current, timeout: PASSKEY_TIMEOUT_MS });
        return start(res.prfOutput, { credentialId: res.credentialId }, address);
      });
    },
    [expiresAt, run, start, address],
  );

  const switchPersona = useCallback(
    async (p: Persona) => {
      const prev = personaRef.current;
      personaRef.current = p;
      try {
        await run(async () => {
          const res = await getPasskeyPrfOutput({ rpId: rpId(), credential: credRef.current, timeout: PASSKEY_TIMEOUT_MS });
          await start(res.prfOutput, { credentialId: res.credentialId });
        });
        setPersona(p);
      } catch (e) {
        personaRef.current = prev;
        throw e;
      }
    },
    [run, start],
  );

  const prf = useCallback(
    (salt: Uint8Array) =>
      run(async () => {
        const res = await getPasskeyPrfOutput({ rpId: rpId(), credential: credRef.current, prfSalt: salt as Uint8Array<ArrayBuffer>, timeout: PASSKEY_TIMEOUT_MS });
        setStatus(sessionRef.current ? "signed-in" : "signed-out");
        return res.prfOutput as Uint8Array;
      }),
    [run],
  );

  return (
    <Ctx.Provider value={{ status, address, expiresAt, error, supported, create, signIn, signOut, cancel, authorize, prf, persona, switchPersona }}>
      {children}
    </Ctx.Provider>
  );
}

/** E1/E2 hook. Contract calls should go through `authorize(risk)` to get a signer. */
export function useMeraSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMeraSession must be used inside <MeraProvider>");
  return v;
}
