import type { Metadata } from "next";

// the page is a client component, so its title lives here
export const metadata: Metadata = { title: "Become a leader" };

export default function BecomeLeaderLayout({ children }: { children: React.ReactNode }) {
  return children;
}
