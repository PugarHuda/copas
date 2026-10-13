import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

// ponytail: script-src keeps 'unsafe-inline' because Next's inline bootstrap has no nonce here; it still blocks
// scripts from any other origin. connect-src allows any https/wss host: the browser talks to several RPCs,
// Envio, HyperSync and Kuru, and a missed host would break a money flow. HSTS is set by Vercel.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' https: wss:${dev ? " http://localhost:* ws://localhost:*" : ""}`,
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // the Telegram Mini App renders Copas in an iframe on Telegram Web; nobody else may frame it (clickjacking)
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
      },
    ];
  },
};

export default nextConfig;
