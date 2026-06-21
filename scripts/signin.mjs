#!/usr/bin/env node
/**
 * One-time interactive Google sign-in for the bot.
 *
 * Opens a real (headed) Chromium window — the SAME build the container uses —
 * against the persistent profile in data/chrome-profile/. You log into the
 * dedicated recorder Google account; the script detects the session, saves it,
 * and exits. The container then reuses that profile to join meetings already
 * signed in (so org meetings can auto-admit it).
 *
 * Run on a machine with a display:
 *   node scripts/signin.mjs
 */
import path from "node:path";
import { chromium } from "playwright";

const profileDir = process.env.CHROME_USER_DATA_DIR
  ? path.resolve(process.env.CHROME_USER_DATA_DIR)
  : path.resolve("data/chrome-profile");

// Match the bot's launch args so the saved session is consistent.
const args = [
  "--no-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  "--no-first-run",
  "--no-default-browser-check",
  // Encrypt cookies with a fixed key (not the OS keyring) so the saved profile
  // decrypts inside the container too.
  "--password-store=basic",
  "--window-size=1280,900",
];

const SIGNED_IN_COOKIES = ["SAPISID", "__Secure-1PSID", "SID"];

// Google often blocks its bundled Chromium ("this browser may not be secure").
// Drive real Google Chrome instead when available — set BROWSER_CHANNEL=chrome.
// Playwright still adds --password-store=basic, so the saved cookies stay
// portable to the container's Chromium.
const channel = process.env.BROWSER_CHANNEL || undefined;

console.log(`\nUsing profile: ${profileDir}`);
console.log(`Browser: ${channel ? `system '${channel}'` : "Playwright Chromium"}`);
console.log("Opening browser… sign into the dedicated recorder Google account.\n");

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  channel,
  args,
  viewport: null,
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://accounts.google.com/");

console.log("Waiting for sign-in to complete (polling every 2s)…");
console.log("When you see your account is logged in, you can also just close the window.\n");

let stableHits = 0;
let windowClosed = false;
let signedIn = false;
const deadline = Date.now() + 10 * 60 * 1000; // 10 min budget

// Track the user closing the window / quitting the browser.
ctx.on("close", () => {
  windowClosed = true;
});

const isSignedIn = async () => {
  try {
    const cookies = await ctx.cookies("https://google.com");
    return cookies.some((c) => SIGNED_IN_COOKIES.includes(c.name) && c.value);
  } catch {
    return false;
  }
};

while (Date.now() < deadline) {
  if (windowClosed || ctx.pages().length === 0) {
    console.log("Browser window closed.");
    break;
  }
  if (await isSignedIn()) {
    stableHits++;
    if (stableHits >= 2) {
      signedIn = true;
      console.log("✅ Detected a signed-in Google session.");
      break;
    }
  } else {
    stableHits = 0;
  }
  await new Promise((r) => setTimeout(r, 2000));
}

// Close cleanly only if the browser is still open (avoids the close-after-close crash).
if (!windowClosed) {
  try {
    await ctx.close();
  } catch {
    /* already gone */
  }
}

console.log(`\nSession (if completed) saved to ${profileDir}.`);
if (!signedIn) {
  console.log("⚠️  Did not positively confirm sign-in before the window closed —");
  console.log("    we'll verify the saved cookies on disk next.");
}
console.log("The container mounts ./data, so it reuses this login. Re-run anytime.\n");
process.exit(0);
