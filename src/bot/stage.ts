import type { Page } from "playwright";
import type { Logger } from "../logger.js";
import { findFirst } from "./selectors.js";
import { sleep } from "../util.js";

/**
 * Close transient in-call popups (e.g. "Use Gemini to take notes", feature
 * tips) so they don't sit on top of the recording. Best-effort and bounded so
 * it never loops. Safe to call repeatedly during the call.
 */
export async function dismissPopups(page: Page, log: Logger): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const btn = await findFirst(page, "popupDismiss", 1200);
    if (!btn) break;
    await btn.click({ timeout: 1500 }).catch(() => {});
    log.debug("dismissed an in-call popup");
    await sleep(400);
  }
}

/**
 * Switch Meet to the requested layout (default "spotlight") so the frame shows
 * only the active speaker / shared screen instead of a grid of (often
 * camera-off) participant tiles. This is a local view setting — it only changes
 * what the bot records, not anyone else's view.
 *
 * Best-effort: Meet's menu is fiddly and changes, so failures are logged and the
 * recording continues with the default layout.
 */
export async function applyLayout(page: Page, layout: string, log: Logger): Promise<void> {
  if (layout === "auto") return; // Meet's default; nothing to do

  // Meet renamed "Change layout" → "Adjust view"; match both.
  const changeItem = () =>
    page
      .getByRole("menuitem", { name: /adjust view|change layout/i })
      .or(page.getByText(/^(adjust view|change layout)$/i))
      .first();

  try {
    // There are several "More options" buttons (each participant tile has one
    // plus the bottom toolbar). Try each until one opens a menu that actually
    // contains "Change layout".
    const moreButtons = page.getByRole("button", { name: /^more options$/i });
    const count = await moreButtons.count();
    let opened = false;
    for (let i = 0; i < count; i++) {
      await moreButtons.nth(i).click().catch(() => {});
      await sleep(700);
      if (await changeItem().isVisible().catch(() => false)) {
        opened = true;
        break;
      }
      await page.keyboard.press("Escape").catch(() => {});
    }
    if (!opened) {
      const items = await page.getByRole("menuitem").allInnerTexts().catch(() => []);
      log.warn({ menuItems: items }, "layout: 'Change layout' not found — leaving default layout");
      return;
    }

    await changeItem().click();
    await sleep(800);

    const re = new RegExp(`^\\s*${layout}\\s*$`, "i");
    const option = page
      .getByRole("radio", { name: re })
      .or(page.getByRole("button", { name: re }))
      .or(page.getByText(re))
      .first();
    if (!(await option.isVisible().catch(() => false))) {
      const opts = await page.getByRole("radio").allInnerTexts().catch(() => []);
      log.warn({ wanted: layout, options: opts }, "layout: option not found in panel");
      await page.keyboard.press("Escape").catch(() => {});
      return;
    }
    await option.click({ timeout: 3000 });
    log.info({ layout }, "set Meet layout");
    await sleep(500);

    const close = await findFirst(page, "closeDialog", 2000);
    if (close) await close.click().catch(() => {});
    else await page.keyboard.press("Escape").catch(() => {});
  } catch (err) {
    log.warn({ err }, "could not set layout (continuing with default)");
  }
}
