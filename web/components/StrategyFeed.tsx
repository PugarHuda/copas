"use client";
import { useCallback, useEffect, useState } from "react";
import type { Abi } from "viem";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { feedKeyFromPrf, feedSalt, openNote, sealNote, blobReaders, type FeedKey } from "@/lib/mera/feed";
import { copasAbi, deployment } from "@/lib/copas/contracts";
import { copasPublic, useCopasWrite } from "@/lib/copas/useCopasWrite";
import { followerOwners } from "@/lib/copas/feedReaders";
import { useL } from "@/lib/i18n/client";
import { Panel, Source, Empty, btn } from "./ui";

type Post = { blob: `0x${string}`; text: string | null; readers: number };

/** SPEC E3: leader strategy notes, readable only by the leader's followers (Mera PRF "Many Keys"). */
export function StrategyFeed({ book, leader }: { book: string; leader: `0x${string}` }) {
  const L = useL();
  const { status, address, prf } = useMeraSession();
  const { write, pending, error } = useCopasWrite();
  const [key, setKey] = useState<FeedKey>();
  const [published, setPublished] = useState<boolean>();
  const [posts, setPosts] = useState<Post[]>([]);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string>();
  const feed = deployment?.feed;
  const c = feed ? { address: feed, abi: copasAbi.CopasFeed as Abi } : undefined;
  const isLeader = !!address && address.toLowerCase() === leader.toLowerCase();

  const load = useCallback(
    async (k?: FeedKey): Promise<Post[]> => {
      if (!c) return [];
      const blobs = (await copasPublic.readContract({ ...c, functionName: "posts", args: [leader] })) as `0x${string}`[];
      return Promise.all(
        blobs.map(async (blob) =>
          k && address
            ? { blob, ...(await openNote(blob, address, k).catch(() => ({ text: null, readers: blobReaders(blob) }))) }
            : { blob, text: null, readers: blobReaders(blob) },
        ),
      );
    },
    [c?.address, leader, address], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // a keyless load still in flight must not overwrite the decrypted one that finished first
  useEffect(() => {
    let live = true;
    load(key).then((p) => live && setPosts(p), () => undefined);
    return () => void (live = false);
  }, [load, key]);

  const unlock = async () => {
    setMsg(undefined);
    const k = await feedKeyFromPrf(await prf(await feedSalt()));
    setKey(k);
    const onchain = (await copasPublic.readContract({ ...c!, functionName: "feedKey", args: [address] })) as string;
    setPublished(onchain.toLowerCase() === k.pub.toLowerCase());
  };

  const publish = async () => {
    if (await write("small", { ...c!, functionName: "setFeedKey", args: [key!.pub] })) setPublished(true);
  };

  const send = async () => {
    const owners = [...new Set([leader.toLowerCase(), ...(await followerOwners(book))])];
    const keys = (await copasPublic.readContract({ ...c!, functionName: "feedKeys", args: [owners] })) as string[];
    const readers = owners.map((a, i) => ({ address: a, pub: keys[i] })).filter((r) => !/^0x0+$/.test(r.pub));
    const blob = await sealNote(note, key!, readers);
    if (await write("small", { ...c!, functionName: "post", args: [blob] })) {
      setNote("");
      setMsg(L(`Terkirim, terenkripsi untuk ${readers.length} pembaca.`, `Posted, encrypted for ${readers.length} readers.`));
      setPosts(await load(key));
    }
  };

  if (!c) return null;
  return (
    <Panel title={L("Catatan strategi (terenkripsi)", "Strategy notes (encrypted)")} aside={<Source kind="live">CopasFeed · Mera PRF</Source>}>
      <p className="text-xs leading-relaxed text-ink-3">
        {L(
          "Dienkripsi di browser dengan kunci X25519 dari passkey yang sama (salt PRF kedua). Onchain hanya ciphertext; hanya follower yang bisa membuka, di device mana pun.",
          "Encrypted in the browser with an X25519 key from the same passkey (a second PRF salt). Only ciphertext goes onchain; only followers can open it, on any device.",
        )}
      </p>
      {status === "signed-in" && !key && (
        <button className={btn.ghost + " mt-3"} onClick={() => unlock().catch((e) => setMsg(String(e?.message ?? e)))}>
          {L("Buka dengan passkey", "Unlock with passkey")}
        </button>
      )}
      {key && published === false && (
        <button className={btn.ghost + " mt-3"} onClick={publish} disabled={pending}>
          {L("Publikasikan kunci feed (sekali)", "Publish feed key (once)")}
        </button>
      )}
      {key && published && isLeader && (
        <div className="mt-3 grid gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={4000}
            className="rounded-md border border-line-strong bg-surface-2 p-2 text-sm"
            placeholder={L("Rencana minggu ini…", "This week's plan…")}
          />
          <button className={btn.primary} onClick={() => send().catch((e) => setMsg(String(e?.message ?? e)))} disabled={pending || !note.trim()}>
            {L("Kirim ke follower", "Send to followers")}
          </button>
        </div>
      )}
      {(msg || error) && <p className="mt-2 text-xs text-ink-2">{msg ?? error}</p>}
      {posts.length === 0 && <Empty>{L("Belum ada catatan.", "No notes yet.")}</Empty>}
      <ul className="mt-4 grid gap-2">
        {[...posts].reverse().map((p, i) => (
          <li key={p.blob.slice(0, 40) + i} className="rounded-md border border-line p-3 text-sm">
            {p.text ?? <span className="text-ink-3">🔒 {L(`Terenkripsi untuk ${p.readers} pembaca`, `Encrypted for ${p.readers} readers`)}</span>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
