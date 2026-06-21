import type { Locator, Page } from "playwright";

/**
 * Centralized, resilient element lookups for the Google Meet UI.
 *
 * Meet ships obfuscated class names that change frequently, so every lookup
 * lists MULTIPLE candidate strategies (accessible role/name, aria-label,
 * visible text, stable-ish attributes). We try them in order and use the first
 * that resolves. When Meet changes its UI, you usually only need to add one new
 * candidate here rather than touch the join/monitor logic.
 *
 * Keep the most specific / most stable strategy first.
 */

export type Candidate = (page: Page) => Locator;

export const candidates: Record<string, Candidate[]> = {
  // Cookie / "Got it" style consent dialogs shown before the join screen.
  dismissConsent: [
    (p) => p.getByRole("button", { name: /^(got it|i agree|accept all)$/i }),
    (p) => p.getByRole("button", { name: /dismiss/i }),
  ],

  // Anonymous "Your name" field (only present when not signed in).
  nameInput: [
    (p) => p.getByPlaceholder(/your name/i),
    (p) => p.getByLabel(/your name/i),
    (p) => p.locator('input[type="text"]:visible').first(),
  ],

  // The primary join button. "Join now" = admitted directly; "Ask to join" =
  // lobby/waiting room. "Switch here" appears when the bot's OWN account is
  // already in the call (e.g. a ghost from a crashed prior session) — clicking
  // it reclaims that session, which is exactly what we want for a dedicated bot.
  joinButton: [
    (p) => p.getByRole("button", { name: /^(join now|ask to join|switch here)$/i }),
    (p) => p.getByRole("button", { name: /join now|ask to join|join the call|switch here/i }),
    (p) =>
      p
        .locator('button:has-text("Join now"), button:has-text("Ask to join"), button:has-text("Switch here")')
        .first(),
  ],

  // Microphone toggle on the green room and in-call. Carries data-is-muted.
  micToggle: [
    (p) => p.getByRole("button", { name: /turn off microphone|turn on microphone/i }),
    (p) => p.locator('[aria-label*="microphone" i][role="button"]').first(),
    (p) => p.locator('[data-is-muted][aria-label*="micro" i]').first(),
  ],

  // Camera toggle. Carries data-is-muted.
  camToggle: [
    (p) => p.getByRole("button", { name: /turn off camera|turn on camera/i }),
    (p) => p.locator('[aria-label*="camera" i][role="button"]').first(),
    (p) => p.locator('[data-is-muted][aria-label*="camera" i]').first(),
  ],

  // Leave-call button. Its presence is our primary "we are in the meeting" signal.
  leaveButton: [
    (p) => p.getByRole("button", { name: /leave call/i }),
    (p) => p.locator('[aria-label*="leave call" i]').first(),
    (p) => p.locator('button[jsname][data-tooltip*="Leave" i]').first(),
  ],

  // "People" / participants panel toggle (also exposes a count badge).
  peopleButton: [
    (p) => p.getByRole("button", { name: /show everyone|people|participants/i }),
    (p) => p.locator('[aria-label*="people" i][role="button"], [aria-label*="everyone" i][role="button"]').first(),
  ],

  // In-call "More options" (three-dot) button on the bottom toolbar.
  moreOptions: [
    (p) => p.getByRole("button", { name: /^more options$/i }),
    (p) => p.locator('button[aria-label="More options"]').last(),
    (p) => p.locator('[aria-label*="more option" i][role="button"]').last(),
  ],

  // "Change layout" entry inside the More-options menu.
  changeLayout: [
    (p) => p.getByRole("menuitem", { name: /change layout/i }),
    (p) => p.getByText(/^change layout$/i),
  ],

  // Generic dialog close button (e.g. to close the layout dialog).
  closeDialog: [
    (p) => p.getByRole("button", { name: /^close$/i }),
    (p) => p.locator('[aria-label="Close"][role="button"]').last(),
  ],

  // Dismiss-style buttons on transient in-call popups (Gemini notes, tips…).
  popupDismiss: [
    (p) => p.getByRole("button", { name: /no thanks|not now|got it|dismiss|maybe later|skip/i }),
  ],

  // Text shown after being removed / when the call ends.
  removedNotice: [
    (p) => p.getByText(/you('ve| have) been removed|you left the meeting|call ended|return to home screen/i),
    (p) => p.getByRole("button", { name: /return to home screen|rejoin/i }),
  ],
};

/**
 * Return the first candidate locator that becomes visible within `timeoutMs`.
 * Races all candidates so reordering strategies is cheap. Returns null on timeout.
 */
export async function findFirst(
  page: Page,
  key: keyof typeof candidates,
  timeoutMs: number,
): Promise<Locator | null> {
  const list = candidates[key];
  if (!list) throw new Error(`Unknown selector key: ${key}`);
  const attempts = list.map(async (build) => {
    const loc = build(page);
    await loc.first().waitFor({ state: "visible", timeout: timeoutMs });
    return loc.first();
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

/** True if any candidate for `key` is currently visible (no waiting). */
export async function isVisible(page: Page, key: keyof typeof candidates): Promise<boolean> {
  for (const build of candidates[key] ?? []) {
    try {
      if (await build(page).first().isVisible()) return true;
    } catch {
      /* detached/navigating — ignore */
    }
  }
  return false;
}
