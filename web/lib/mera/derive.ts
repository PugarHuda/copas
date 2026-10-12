import { createSecp256k1SigningSession, getEvmAddress, type Secp256k1SigningSession } from "@category-labs/mera";

const enc = new TextEncoder();

/**
 * PRF output (32 bytes, same on every sign-in) -> secp256k1 private key.
 * Mera leaves derivation to the app. We use WebCrypto HKDF-SHA256 with a
 * versioned label so the scheme can never silently change.
 * ponytail: HKDF instead of BIP39/BIP32 — no extra deps; switch to bip32 m/44'/60'/0'/0/0
 * if users need to import the same account into a seed-phrase wallet.
 */
export async function deriveEvmPrivateKey(prfOutput: Uint8Array, index = 0): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", prfOutput as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("copas.evm.v1"), info: enc.encode(`secp256k1/account/${index}`) },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * E4: account 0 is the main identity, account 1 the private follower identity. Both come from the same PRF output through
 * HKDF with different `info`, so neither address reveals the other: only the passkey links them.
 */
export type Persona = 0 | 1;

/** Builds a signing session and wipes every intermediate key copy we own. */
export async function sessionFromPrf(prfOutput: Uint8Array, persona: Persona = 0): Promise<{ session: Secp256k1SigningSession; address: `0x${string}` }> {
  const privateKey = await deriveEvmPrivateKey(prfOutput, persona);
  try {
    const session = createSecp256k1SigningSession({ privateKey });
    return { session, address: getEvmAddress(session.publicKey) };
  } finally {
    privateKey.fill(0);
    prfOutput.fill(0);
  }
}
