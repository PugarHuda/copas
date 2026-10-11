"use client";
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { isAddress } from "../format";

/** H4: `?ref=0x…` on any landing URL is remembered and applied with FollowerVault.setReferrer() after createVault. */
const KEY = "copas.ref";

export function ReferralCapture() {
  const params = useSearchParams();
  useEffect(() => {
    const ref = params.get("ref");
    if (ref && isAddress(ref)) {
      try {
        if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, ref);
      } catch {
        /* storage blocked */
      }
    }
  }, [params]);
  return null;
}

export function getReferrer(): `0x${string}` | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return v && isAddress(v) ? (v as `0x${string}`) : undefined;
  } catch {
    return undefined;
  }
}
