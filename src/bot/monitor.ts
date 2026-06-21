import type { Page } from "playwright";
import type { Logger } from "../logger.js";
import type { MeetingState } from "../types.js";
import { isVisible } from "./selectors.js";

/**
 * Best-effort read of the live meeting state from the DOM.
 *
 * Participant counting is the fragile part of any Meet bot. We try, in order:
 *   1. unique `[data-participant-id]` nodes (Meet tags each participant tile),
 *   2. a numeric badge on the People button,
 *   3. fall back to 1 (assume just us) so an unreadable DOM trends toward
 *      "empty" rather than recording forever.
 */
export async function readMeetingState(page: Page, log: Logger): Promise<MeetingState> {
  const inMeeting = await isVisible(page, "leaveButton");

  let participantCount = 1;
  let screenShareActive = false;
  try {
    const probe = await page.evaluate(() => {
      const uniq = (sel: string) => {
        const ids = new Set<string>();
        document.querySelectorAll(sel).forEach((el) => {
          const id = el.getAttribute("data-participant-id") || el.getAttribute("data-requested-participant-id");
          if (id) ids.add(id);
        });
        return ids.size;
      };

      let count = uniq("[data-participant-id]");
      if (count === 0) count = uniq("[data-requested-participant-id]");

      // Fallback: a count badge near the People button.
      if (count === 0) {
        const labels = Array.from(document.querySelectorAll('[aria-label*="participant" i], [aria-label*="people" i]'));
        for (const el of labels) {
          const m = (el.getAttribute("aria-label") || el.textContent || "").match(/(\d+)/);
          if (m) {
            count = Math.max(count, Number.parseInt(m[1]!, 10));
          }
        }
      }

      // Screen-share heuristic: a tile/banner saying someone is presenting.
      const presenting =
        !!document.querySelector('[aria-label*="presentation" i], [aria-label*="is presenting" i]') ||
        /is presenting|you are presenting|presentation to everyone/i.test(document.body.innerText);

      return { count, presenting };
    });
    participantCount = Math.max(1, probe.count || 1);
    screenShareActive = probe.presenting;
  } catch (err) {
    log.debug({ err }, "participant probe failed (page navigating?)");
  }

  return { participantCount, inMeeting, screenShareActive };
}
