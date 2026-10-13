import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { dropDelegation, dynamicMessage, dynamicWallet, saveDelegation, verifyWebhook } from "@/lib/dynamic/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Enc = { alg: string; iv: string; ct: string; tag: string; ek: string; kid?: string };
type Body = {
  eventId?: string;
  eventName?: string;
  userId?: string;
  data?: { walletId?: string; publicKey?: string; shareSetId?: string; encryptedDelegatedShare?: Enc; encryptedWalletApiKey?: Enc };
};

// Dynamic delegated access: wallet.delegation.created carries the follower's delegated MPC share + per-wallet API key,
// encrypted to our RSA key; wallet.delegation.revoked means the share is dead and we forget it.
export async function POST(req: Request) {
  const raw = await req.text();
  const sig = verifyWebhook(raw, req.headers.get("x-dynamic-signature-256"));
  if (sig === false) return NextResponse.json({ error: "bad signature" }, { status: 401 });
  let body: Body;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (sig === "unset") {
    // No HMAC secret configured (the API does not expose it): fail closed unless Dynamic's own delivery log has this
    // exact message, and then act on Dynamic's copy, not on what was posted.
    const confirmed = await dynamicMessage(body as Record<string, unknown>);
    if (!confirmed) return NextResponse.json({ error: "unverified" }, { status: 401 });
    body = confirmed as Body;
  }
  const d = body.data;
  if (body.eventName === "wallet.delegation.created" && d?.walletId && d.publicKey && d.encryptedDelegatedShare && d.encryptedWalletApiKey) {
    // Signed by Dynamic, and still cross-checked: the wallet id must belong to that address in our environment.
    const w = await dynamicWallet(d.walletId);
    if (!w?.address || w.address.toLowerCase() !== d.publicKey.toLowerCase()) return NextResponse.json({ error: "unknown wallet" }, { status: 401 });
    const { decryptDelegatedWebhookData } = await import("@dynamic-labs-wallet/node");
    const pem = Buffer.from(process.env.DYNAMIC_DELEGATION_PRIVATE_KEY!, "base64").toString("utf8");
    const { decryptedDelegatedShare, decryptedWalletApiKey } = decryptDelegatedWebhookData({
      privateKeyPem: pem,
      encryptedDelegatedKeyShare: d.encryptedDelegatedShare as never,
      encryptedWalletApiKey: d.encryptedWalletApiKey as never,
    });
    await saveDelegation({
      walletId: d.walletId,
      address: getAddress(d.publicKey),
      userId: body.userId,
      shareSetId: d.shareSetId,
      walletApiKey: decryptedWalletApiKey,
      keyShare: decryptedDelegatedShare,
      at: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true, stored: d.walletId });
  }
  if (body.eventName === "wallet.delegation.revoked" && d?.walletId) {
    // Only forget the share once Dynamic's API agrees the wallet no longer has a delegated share.
    const w = await dynamicWallet(d.walletId);
    if (!w?.address || w.delegated !== false) return NextResponse.json({ error: "revocation not confirmed" }, { status: 409 });
    await dropDelegation(w.address);
    return NextResponse.json({ ok: true, dropped: d.walletId });
  }
  return NextResponse.json({ ok: true, ignored: body.eventName ?? null });
}
