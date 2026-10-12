/**
 * SPEC E3 (Mera "Many Keys"): an X25519 key from the same passkey under a second PRF salt.
 * Leader notes: AES-256-GCM with a random content key, wrapped per reader with ECDH(X25519) + HKDF.
 * Only ciphertext and public keys go onchain (CopasFeed). WebCrypto only, no deps.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const feedSalt = async () => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("copas.feed.v1")));

export type FeedKey = { priv: CryptoKey; pub: `0x${string}` };

/** PRF output -> X25519 key pair. Wipes the PRF bytes. */
export async function feedKeyFromPrf(prf: Uint8Array): Promise<FeedKey> {
  try {
    const ikm = await crypto.subtle.importKey("raw", prf as BufferSource, "HKDF", false, ["deriveBits"]);
    const seed = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("copas.feed.v1"), info: enc.encode("x25519/0") }, ikm, 256),
    );
    // PKCS#8 wrapper for a raw X25519 private key (RFC 8410).
    const pkcs8 = new Uint8Array([...unhex("0x302e020100300506032b656e04220420"), ...seed]);
    seed.fill(0);
    const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, true, ["deriveBits"]);
    pkcs8.fill(0);
    const { x } = await crypto.subtle.exportKey("jwk", priv);
    return { priv, pub: hex(b64u(x!)) as `0x${string}` };
  } finally {
    prf.fill(0);
  }
}

async function wrapKey(priv: CryptoKey, peerPub: string) {
  const peer = await crypto.subtle.importKey("raw", unhex(peerPub), { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, priv, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode("copas.feed.wrap.v1") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

type Blob = { v: 1; from: string; iv: string; ct: string; w: { to: string; iv: string; k: string }[] };

/** Encrypts `note` for readers (address -> X25519 pub). Include yourself to read your own posts. */
export async function sealNote(note: string, me: FeedKey, readers: { address: string; pub: string }[]): Promise<`0x${string}`> {
  const cek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(note)));
  const w = await Promise.all(
    readers.map(async (r) => {
      const wiv = crypto.getRandomValues(new Uint8Array(12));
      const wk = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wiv }, await wrapKey(me.priv, r.pub), cek));
      return { to: r.address.toLowerCase(), iv: hex(wiv), k: hex(wk) };
    }),
  );
  cek.fill(0);
  const blob: Blob = { v: 1, from: me.pub, iv: hex(iv), ct: hex(ct), w };
  return hex(enc.encode(JSON.stringify(blob))) as `0x${string}`;
}

/** Opens a CopasFeed blob for `address`. Returns null when it was not sealed for us. */
export async function openNote(blobHex: string, address: string, me: FeedKey): Promise<{ text: string | null; readers: number }> {
  const b = JSON.parse(dec.decode(unhex(blobHex))) as Blob;
  const mine = b.w.find((x) => x.to === address.toLowerCase());
  if (!mine) return { text: null, readers: b.w.length };
  const wk = await wrapKey(me.priv, b.from);
  const cek = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(mine.iv) }, wk, unhex(mine.k));
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(b.iv) }, k, unhex(b.ct));
  return { text: dec.decode(pt), readers: b.w.length };
}

/** Reader count of a blob without any key (for locked posts). */
export const blobReaders = (blobHex: string) => {
  try {
    return (JSON.parse(dec.decode(unhex(blobHex))) as Blob).w.length;
  } catch {
    return 0;
  }
};
