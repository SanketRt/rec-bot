import { google } from "googleapis";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { normalizeMeetUrl } from "../util.js";
import type { ScheduledMeeting, ScheduleSource } from "./types.js";

/**
 * Pulls upcoming events from a Google Calendar and records any that carry a
 * Meet link. Reuses the same OAuth refresh token as the YouTube uploader.
 *
 * Point GCAL_CALENDAR_ID at the calendar that holds your lecture schedule and
 * the bot will auto-join each session — no manual link entry at all.
 */
export class GoogleCalendarSource implements ScheduleSource {
  private readonly calendar;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    if (!cfg.googleClientId || !cfg.googleClientSecret || !cfg.googleRefreshToken) {
      throw new Error("Google Calendar source needs GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN");
    }
    const auth = new google.auth.OAuth2(cfg.googleClientId, cfg.googleClientSecret);
    auth.setCredentials({ refresh_token: cfg.googleRefreshToken });
    this.calendar = google.calendar({ version: "v3", auth });
  }

  async upcoming(now: Date, lookaheadMs: number): Promise<ScheduledMeeting[]> {
    // Look a bit past the lookahead so an in-progress meeting we missed still
    // gets picked up if the bot restarted.
    const timeMin = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + Math.max(lookaheadMs, 15 * 60 * 1000)).toISOString();

    const res = await this.calendar.events.list({
      calendarId: this.cfg.gcalCalendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20,
    });

    const out: ScheduledMeeting[] = [];
    for (const ev of res.data.items ?? []) {
      const startsAt = ev.start?.dateTime ? new Date(ev.start.dateTime) : undefined;
      if (!startsAt) continue; // skip all-day events
      const endsAt = ev.end?.dateTime ? new Date(ev.end.dateTime) : undefined;

      const meetUrl = this.extractMeetUrl(ev);
      if (!meetUrl) continue;

      const joinAt = startsAt.getTime() - lookaheadMs;
      if (now.getTime() >= joinAt && (!endsAt || now < endsAt)) {
        out.push({
          key: `${ev.id}@${ev.start?.dateTime}`,
          meetUrl,
          title: ev.summary ?? "ANCC Lecture",
          startsAt,
          endsAt,
        });
      }
    }
    return out;
  }

  /** Find a Meet link in hangoutLink, conferenceData, or the description. */
  private extractMeetUrl(ev: import("googleapis").calendar_v3.Schema$Event): string | null {
    if (ev.hangoutLink) {
      const n = normalizeMeetUrl(ev.hangoutLink);
      if (n) return n;
    }
    for (const ep of ev.conferenceData?.entryPoints ?? []) {
      if (ep.uri) {
        const n = normalizeMeetUrl(ep.uri);
        if (n) return n;
      }
    }
    const m = (ev.description ?? "").match(/meet\.google\.com\/[a-z-]+/i);
    return m ? normalizeMeetUrl(m[0]) : null;
  }
}
