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
 * Hide the bot's own self-view tile (the small floating tile of the bot itself).
 * Best-effort: opens each tile's "More options" menu and clicks "Minimize".
 *
 * Returns true once the self-view is hidden. Returns false (without throwing) if
 * the control isn't available yet — notably, Meet *disables* "Minimize" while the
 * bot is the only participant, so the caller should retry once others join.
 */
export async function hideSelfView(page: Page, log: Logger): Promise<boolean> {
  const hideItem = () =>
    page
      .getByRole("menuitem", { name: /minimi[sz]e|hide self|hide your tile|hide from (your )?screen/i })
      .first();

  try {
    // The hide/minimize control lives inside a tile's "More options for <name>"
    // menu. There's one per participant; the self tile's menu is the one that
    // offers a minimize/hide entry, so try each until we find an enabled one.
    const menus = page.locator('[aria-label^="More options for" i]');
    const count = await menus.count();
    for (let i = 0; i < count; i++) {
      const label = await menus.nth(i).getAttribute("aria-label").catch(() => "");
      await menus.nth(i).click().catch(() => {});
      await sleep(500);
      const item = hideItem();
      if (await item.isVisible().catch(() => false)) {
        // Meet greys out "Minimize" (aria-disabled) when the bot is alone in the
        // call. Don't click a disabled item — bail so the caller retries later.
        const disabled =
          (await item.getAttribute("aria-disabled").catch(() => null)) === "true" ||
          !(await item.isEnabled().catch(() => true));
        if (disabled) {
          log.debug({ tile: label }, "hide self-view: 'Minimize' present but disabled (will retry)");
          await page.keyboard.press("Escape").catch(() => {});
          await sleep(200);
          continue;
        }
        await item.click({ timeout: 2000 });
        log.info({ tile: label }, "hid self-view");
        await sleep(400);
        return true;
      }
      const items = await page.getByRole("menuitem").allInnerTexts().catch(() => []);
      log.debug({ tile: label, items }, "tile menu items (looking for hide self-view)");
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(200);
    }
    log.debug("hide self-view: no enabled minimize/hide control found yet (will retry)");
    return false;
  } catch (err) {
    log.debug({ err }, "hide self-view attempt failed (will retry)");
    return false;
  }
}

/**
 * Switch Meet to the requested layout (default "spotlight") so the frame shows
 * only the active speaker / shared screen instead of a grid of (often
 * camera-off) participant tiles. This is a local view setting — it only changes
 * what the bot records, not anyone else's view.
 *
 * Best-effort: Meet's menu is fiddly and changes, so failures are logged and the
 * recording continues with the default layout. Returns true once the layout has
 * been set (or "auto", which needs nothing). Returns false if the "Adjust view"
 * control isn't available yet — Meet hides it while the bot is alone, so the
 * caller should retry once other participants join.
 */
export async function applyLayout(page: Page, layout: string, log: Logger): Promise<boolean> {
  if (layout === "auto") return true; // Meet's default; nothing to do

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
      log.debug({ menuItems: items }, "layout: 'Adjust view' not available yet (will retry)");
      return false;
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
      return false;
    }
    await option.click({ timeout: 3000 });
    log.info({ layout }, "set Meet layout");
    await sleep(500);

    const close = await findFirst(page, "closeDialog", 2000);
    if (close) await close.click().catch(() => {});
    else await page.keyboard.press("Escape").catch(() => {});
    return true;
  } catch (err) {
    log.debug({ err }, "layout attempt failed (will retry)");
    return false;
  }
}
