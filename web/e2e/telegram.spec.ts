import { test, expect } from "@playwright/test";

test.describe("Telegram webhook", () => {
  test.skip(({ isMobile }) => isMobile, "API checks are viewport-independent");
  const update = { update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" }, text: "/leaders" } };

  test("refuses an update without the secret header", async ({ request }) => {
    const res = await request.post("/api/telegram", { data: update });
    expect(res.status()).toBe(401);
  });
  test("refuses an update with a wrong secret", async ({ request }) => {
    const res = await request.post("/api/telegram", { data: update, headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" } });
    expect(res.status()).toBe(401);
  });
});
