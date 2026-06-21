import path from "node:path";
import { rm, readFile, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { ensureDir } from "../util.js";

/**
 * Chrome leaves these lock files in the profile if a previous run was killed
 * uncleanly (e.g. a hard `docker kill`), which then blocks the next launch with
 * "the profile appears to be in use". Only one bot ever uses this profile at a
 * time, so clearing stale locks on startup is safe and avoids a wedged bot.
 */
async function clearStaleProfileLocks(userDataDir: string, log: Logger): Promise<void> {
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(path.join(userDataDir, f), { force: true }).catch((err) =>
      log.debug({ err, f }, "could not remove stale lock (continuing)"),
    );
  }
}

/**
 * Mark the profile as having exited cleanly, so Chrome doesn't show the
 * "Restore pages? Chrome didn't shut down correctly" bubble (that bubble is
 * browser chrome, not page content, so it can't be clicked away — it has to be
 * prevented here). Needed because hard kills leave exit_type = "Crashed".
 */
async function markProfileCleanExit(userDataDir: string, log: Logger): Promise<void> {
  const prefsPath = path.join(userDataDir, "Default", "Preferences");
  try {
    const prefs = JSON.parse(await readFile(prefsPath, "utf8"));
    prefs.profile ??= {};
    prefs.profile.exit_type = "Normal";
    prefs.profile.exited_cleanly = true;
    await writeFile(prefsPath, JSON.stringify(prefs));
    log.debug("reset profile exit_type to Normal");
  } catch (err) {
    log.debug({ err }, "could not sanitize profile Preferences (continuing)");
  }
}

export interface BrowserHandle {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Launch a *headed* Chromium inside the virtual display.
 *
 * Why headed: fully headless Chromium is fingerprinted and frequently blocked
 * from Meet. We run a real Chromium against Xvfb (DISPLAY) instead, which is
 * indistinguishable from a normal desktop browser to Meet.
 *
 * A persistent user-data-dir keeps the bot's Google session, so it only signs
 * in once (recommended over scripting the password form, which trips Google's
 * automation defenses).
 */
export async function launchBrowser(cfg: Config, log: Logger): Promise<BrowserHandle> {
  await ensureDir(cfg.chromeUserDataDir!);
  await clearStaleProfileLocks(cfg.chromeUserDataDir!, log);
  await markProfileCleanExit(cfg.chromeUserDataDir!, log);

  const { screenWidth: w, screenHeight: h } = cfg;

  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage", // avoid /dev/shm exhaustion crashes in containers
    "--disable-gpu", // no GPU on a headless VM
    "--use-gl=angle",
    "--use-angle=swiftshader", // software GL so WebGL/compositing still works
    "--disable-blink-features=AutomationControlled", // hide the webdriver flag
    "--password-store=basic", // fixed cookie-encryption key -> profile is portable across hosts
    "--autoplay-policy=no-user-gesture-required", // let remote audio play immediately
    "--disable-features=IsolateOrigins,site-per-process,Translate",
    "--disable-infobars",
    "--test-type", // suppress the "unsupported flag --no-sandbox" warning bar
    "--hide-crash-restore-bubble", // no "Restore pages?" bubble blocking the frame
    "--disable-session-crashed-bubble",
    "--disable-notifications",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    `--window-size=${w},${h}`,
    "--start-fullscreen",
  ];

  log.info({ userDataDir: cfg.chromeUserDataDir, w, h }, "launching chromium");

  const context = await chromium.launchPersistentContext(cfg.chromeUserDataDir!, {
    headless: false,
    channel: cfg.browserChannel, // e.g. "chrome"; undefined -> bundled Chromium
    executablePath: cfg.chromeExecutable, // undefined -> Playwright's bundled Chromium
    args,
    viewport: null, // use the real OS window size (== Xvfb screen) so capture is full-frame
    locale: "en-US",
    timezoneId: process.env.TZ || "Asia/Kolkata",
    // Deny camera/mic: the bot must never transmit. It still *hears* the call,
    // because remote audio is played to the output sink we record — output
    // playback needs no permission.
    permissions: [],
    // Keep audio un-muted (we record it); drop the automation switch so the
    // "Chrome is being controlled by automated test software" banner is gone.
    ignoreDefaultArgs: ["--mute-audio", "--enable-automation"],
  });

  // Belt-and-suspenders: explicitly deny media capture for meet.google.com.
  await context.clearPermissions();

  const page = context.pages()[0] ?? (await context.newPage());

  // Light anti-detection: strip navigator.webdriver before any page script runs.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const close = async () => {
    try {
      await context.close();
    } catch (err) {
      log.warn({ err }, "error closing browser context");
    }
  };

  return { context, page, close };
}
