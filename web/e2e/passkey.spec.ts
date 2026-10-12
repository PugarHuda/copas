import { expect, test } from "@playwright/test";

/**
 * Mera account layer end to end, with a CDP virtual authenticator that evaluates PRF (no real device, no funds):
 * E1 create + stateless sign-in rebuilds the same address, E4 the private identity is a different address from the
 * same passkey and switching back returns the main one.
 */
test.skip(({ browserName }, info) => browserName !== "chromium" || info.project.name !== "desktop", "CDP WebAuthn: desktop Chromium only");

test("passkey account: create, private identity, stateless sign-in", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });

  await page.goto("/settings");
  const main = page.getByRole("main");
  const addr = main.locator(".num.break-all").first();
  const signedIn = main.getByText(/^(signed in|masuk)$/);

  await main.getByRole("button", { name: /Create passkey account|Buat akun passkey/ }).click();
  await expect(signedIn).toBeVisible();
  const a0 = (await addr.textContent())!.trim();
  expect(a0).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // E4: the private identity is another address from the same passkey
  await main.getByRole("button", { name: /Private identity|Identitas privat/ }).click();
  await expect(addr).not.toHaveText(a0);
  const a1 = (await addr.textContent())!.trim();
  expect(a1).toMatch(/^0x[0-9a-fA-F]{40}$/);
  await expect(page.getByRole("banner").getByText("private")).toBeVisible();
  await main.getByRole("button", { name: /Main account|Akun utama/ }).click();
  await expect(addr).toHaveText(a0);

  // E1: wipe every Copas key from storage, sign in again with the same passkey, get the same address
  await main.getByRole("button", { name: /Clear|Hapus/ }).click();
  await page.waitForLoadState("load");
  await main.getByRole("button", { name: /Sign in with passkey|Masuk dengan passkey/ }).click();
  await expect(signedIn).toBeVisible();
  await expect(addr).toHaveText(a0);
  await expect(main.getByText(/Passed|Lulus/)).toBeVisible();

  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials).toHaveLength(1); // one passkey behind both identities
});
