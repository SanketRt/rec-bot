import { readFile } from "node:fs/promises";
import type { Logger } from "../logger.js";
import { normalizeMeetUrl } from "../util.js";
import type { ScheduledMeeting, ScheduleSource } from "./types.js";

interface FileEntry {
  meetUrl: string;
  title?: string;
  startsAt: string; // ISO 8601, e.g. "2026-06-21T18:00:00+05:30"
  endsAt?: string;
  enabled?: boolean;
}

/**
 * Reads a JSON array of lectures from SCHEDULE_FILE on every poll, so you can
 * edit the file live without restarting. Example:
 * [
 *   { "meetUrl": "https://meet.google.com/abc-defg-hij",
 *     "title": "Algorithms Lecture 3",
 *     "startsAt": "2026-06-21T18:00:00+05:30",
 *     "endsAt":   "2026-06-21T20:00:00+05:30" }
 * ]
 */
export class FileScheduleSource implements ScheduleSource {
  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  async upcoming(now: Date, lookaheadMs: number): Promise<ScheduledMeeting[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return []; // file may not exist yet — that's fine
    }

    let entries: FileEntry[];
    try {
      entries = JSON.parse(raw);
      if (!Array.isArray(entries)) throw new Error("expected a JSON array");
    } catch (err) {
      this.log.error({ err, file: this.file }, "invalid schedule file; ignoring");
      return [];
    }

    const out: ScheduledMeeting[] = [];
    for (const e of entries) {
      if (e.enabled === false) continue;
      const meetUrl = normalizeMeetUrl(e.meetUrl ?? "");
      const startsAt = new Date(e.startsAt);
      if (!meetUrl || Number.isNaN(startsAt.getTime())) {
        this.log.warn({ entry: e }, "skipping invalid schedule entry");
        continue;
      }
      const endsAt = e.endsAt ? new Date(e.endsAt) : undefined;
      // Within the join window: start is near/now and we're not past the end.
      const joinAt = startsAt.getTime() - lookaheadMs;
      if (now.getTime() >= joinAt && (!endsAt || now < endsAt)) {
        out.push({
          key: `${meetUrl}@${startsAt.toISOString()}`,
          meetUrl,
          title: e.title ?? "ANCC Lecture",
          startsAt,
          endsAt,
        });
      }
    }
    return out;
  }
}
