import { expect, test } from "@playwright/test";

// Dynamic delegated access endpoints on the live app.
test.describe("Dynamic webhook + guard", () => {
  test("unsigned or wrongly signed delegation webhooks are refused", async ({ request }) => {
    const body = { eventName: "wallet.delegation.revoked", data: { walletId: "25193936-3ecd-4c1b-84e6-9eabc82e53c2", chain: "EVM" } };
    const unsigned = await request.post("/api/dynamic/webhook", { data: body });
    expect([401, 503]).toContain(unsigned.status());
    const wrong = await request.post("/api/dynamic/webhook", { data: body, headers: { "x-dynamic-signature-256": "sha256=" + "0".repeat(64) } });
    expect([401, 503]).toContain(wrong.status());
  });

  test("guard reads state but refuses to act without a delegation", async ({ request }) => {
    const owner = "0x7a9a8212d6baAD1C813B06fDe7c09de97b1760Cf"; // deployer test account, never delegated
    const g = await request.get(`/api/dynamic/guard?address=${owner}`);
    expect(g.ok()).toBeTruthy();
    expect((await g.json()).delegated).toBe(false);
    const run = await request.post("/api/dynamic/guard", { data: { address: owner } });
    expect(run.status()).toBe(404);
  });
});
