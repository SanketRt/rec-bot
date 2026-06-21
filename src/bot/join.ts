import type { Page } from "playwright";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { findFirst, isVisible } from "./selectors.js";
import { sleep } from "../util.js";

export class JoinError extends Error {
  constructor(
    message: string,
    readonly reason: "navigation" | "no-join-button" | "lobby-timeout" | "rejected",
  ) {
    super(message);
    this.name = "JoinError";
  }
}

/** Ensure a mic/camera toggle is in the OFF (muted) state. Best-effort. */
async function ensureMuted(page: Page, key: "micToggle" | "camToggle", log: Logger): Promise<void> {
  const loc = await findFirst(page, key, 4000);
  if (!loc) {
    log.debug({ key }, "no toggle found (likely already no device) — skipping");
    return;
  }
  try {
    const label = (await loc.getAttribute("aria-label")) ?? "";
    const muted = (await loc.getAttribute("data-is-muted")) === "true";
    // "Turn off ..." label OR data-is-muted=false means it is currently ON.
    if (/turn off/i.test(label) || muted === false) {
      await loc.click({ timeout: 3000 });
      log.debug({ key }, "toggled device off");
    }
  } catch (err) {
    log.debug({ key, err }, "could not toggle device (continuing)");
  }
}

/**
 * Drive the Meet pre-join ("green room") and get the bot admitted into the call.
 * Throws JoinError on any terminal failure so the orchestrator can record the
 * end reason and save a debug screenshot.
 */
export async function joinMeeting(
  page: Page,
  meetUrl: string,
  botName: string,
  cfg: Config,
  log: Logger,
): Promise<void> {
  // 1. Navigate. Meet is a heavy SPA; wait for DOM, not full network idle
  //    (idle never settles on a live call).
  try {
    await page.goto(meetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    log.info({ meetUrl }, "opened meet url");
  } catch (err) {
    throw new JoinError(`failed to open ${meetUrl}: ${(err as Error).message}`, "navigation");
  }
  // Let the green room render.
  await sleep(2500);

  // 2. Dismiss any pre-join consent dialog.
  const consent = await findFirst(page, "dismissConsent", 4000);
  if (consent) {
    await consent.click().catch(() => {});
    log.debug("dismissed consent dialog");
  }

  // 3. Anonymous name entry (only when not signed in).
  const nameField = await findFirst(page, "nameInput", 6000);
  if (nameField) {
    await nameField.fill(botName).catch(() => {});
    log.info({ name: botName }, "entered display name (anonymous join)");
  } else {
    log.info("no name field — joining with the signed-in account");
  }

  // 4. Make sure we are not transmitting.
  await ensureMuted(page, "micToggle", log);
  await ensureMuted(page, "camToggle", log);

  // 5. Click Join now / Ask to join.
  const joinBtn = await findFirst(page, "joinButton", 15_000);
  if (!joinBtn) {
    throw new JoinError("could not find the join button", "no-join-button");
  }
  const joinLabel = (await joinBtn.innerText().catch(() => "")) || "";
  const lobby = /ask to join/i.test(joinLabel);
  await joinBtn.click();
  log.info({ joinLabel, lobby }, "clicked join");

  // 6. Wait for admission: the leave-call button is our "we're in" signal.
  const deadline = Date.now() + cfg.joinTimeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await isVisible(page, "leaveButton")) {
      log.info("admitted to the meeting");
      return;
    }
    if (await isVisible(page, "removedNotice")) {
      throw new JoinError("host rejected the join request", "rejected");
    }
    await sleep(1500);
  }
  throw new JoinError(
    lobby ? "timed out waiting in the lobby for admission" : "join did not complete in time",
    "lobby-timeout",
  );
}

/** Click "Leave call". Safe to call even if already disconnected. */
export async function leaveMeeting(page: Page, log: Logger): Promise<void> {
  try {
    const leave = await findFirst(page, "leaveButton", 4000);
    if (leave) {
      await leave.click({ timeout: 3000 });
      log.info("left the meeting");
      await sleep(1000);
    }
  } catch (err) {
    log.debug({ err }, "leave click failed (probably already disconnected)");
  }
}
