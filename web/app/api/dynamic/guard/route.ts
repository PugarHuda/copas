import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { delegatedProbe, delegatedUnfollow, guardChecks, loadDelegation } from "@/lib/dynamic/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const addrOf = (v: unknown) => (typeof v === "string" && isAddress(v) ? getAddress(v) : null);

/** GET ?address= : is a delegation on file, and what the guard rules say for each followed vault right now. */
export async function GET(req: Request) {
  const address = addrOf(new URL(req.url).searchParams.get("address"));
  if (!address) return NextResponse.json({ error: "bad-address" }, { status: 400 });
  const [d, checks] = await Promise.all([loadDelegation(address).catch(() => null), guardChecks(address)]);
  return NextResponse.json({ delegated: !!d, since: d?.at ?? null, walletId: d?.walletId ?? null, checks });
}

/**
 * POST {address}: runs the guard. Anyone may call it (the keeper, the user, a judge): it only acts when a protective
 * rule holds, and the only thing it can sign is unfollow() on that owner's own vault.
 * POST {address, probe: "withdraw" | "unfollow"}: asks Dynamic to sign that vault call with the delegated share and
 * reports Dynamic's answer (withdraw must be refused). Nothing is broadcast.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { address?: string; probe?: string };
  const address = addrOf(body.address);
  if (!address) return NextResponse.json({ error: "bad-address" }, { status: 400 });
  const d = await loadDelegation(address);
  if (!d) return NextResponse.json({ error: "no-delegation" }, { status: 404 });
  const checks = await guardChecks(address);
  if (body.probe === "withdraw" || body.probe === "unfollow") {
    const v = checks[0]?.vault;
    if (!v) return NextResponse.json({ error: "no-vault" }, { status: 404 });
    return NextResponse.json({ probe: body.probe === "withdraw" ? "vault.withdraw(1)" : "vault.unfollow()", signedOnly: true, vault: v, ...(await delegatedProbe(d, v, body.probe)) });
  }
  const acted = [];
  for (const c of checks.filter((c) => c.reason)) {
    try {
      acted.push({ vault: c.vault, reason: c.reason, ...(await delegatedUnfollow(d, c.vault)) });
    } catch (e) {
      acted.push({ vault: c.vault, reason: c.reason, error: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300) });
    }
  }
  return NextResponse.json({ checks, acted });
}
