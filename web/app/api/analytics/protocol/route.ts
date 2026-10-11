import { NextResponse } from "next/server";
import { protocolSnapshot } from "@/lib/perpl/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await protocolSnapshot(), { headers: { "cache-control": "public, s-maxage=15" } });
}
