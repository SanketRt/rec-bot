// Throwaway check: does the bundled Chromium read the signed-in profile?
// Run inside the container with /data mounted and this file at /app/check.cjs.
const { chromium } = require("playwright");
(async () => {
  const ctx = await chromium.launchPersistentContext("/data/chrome-profile", {
    headless: true,
    channel: process.env.BROWSER_CHANNEL || undefined,
    args: ["--no-sandbox", "--password-store=basic", "--disable-dev-shm-usage"],
  });
  // Diagnostic: do the auth cookies survive into this context?
  const cookies = await ctx.cookies("https://google.com");
  const authNames = cookies
    .map((c) => c.name)
    .filter((n) => ["SAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID"].includes(n));
  console.error(`[diag] google.com cookies seen: ${cookies.length}, auth cookies: ${authNames.join(",") || "NONE"}`);

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page
    .goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 30000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 3500));
  const url = page.url();
  const loggedIn =
    url.includes("myaccount.google.com") && !/signin|accounts\.google\.com\/v3/.test(url);
  let email = null;
  try {
    email = await page.locator("[data-email]").first().getAttribute("data-email", { timeout: 2000 });
  } catch {}
  console.log(JSON.stringify({ url, loggedIn, email }));
  await ctx.close();
  process.exit(loggedIn ? 0 : 3);
})().catch((e) => {
  console.error("CHECK-FAIL", e.message);
  process.exit(1);
});
