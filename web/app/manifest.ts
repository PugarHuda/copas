import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Copas: trade Perpl with a passkey",
    short_name: "Copas",
    description: "Trade Perpl perps on Monad from a Mera passkey account with AUSD, or copy a leader who posted a bond.",
    start_url: "/trade?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0e0f11",
    theme_color: "#0e0f11",
    categories: ["finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Trade", url: "/trade", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Leaders", url: "/", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "My vault", url: "/me", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
