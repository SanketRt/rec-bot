import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { CapacityError, DuplicateError, type SessionManager } from "../manager.js";
import { sleep } from "../util.js";
import { FileScheduleSource } from "./fileSource.js";
import { GoogleCalendarSource } from "./googleCalendar.js";
import type { ScheduleSource } from "./types.js";

/**
 * Polls a schedule source and auto-starts a recording when a lecture's join
 * window opens. Each meeting key is launched at most once per process so a
 * still-listed event isn't re-joined on the next poll.
 */
export class Scheduler {
  private readonly source: ScheduleSource;
  private readonly handled = new Set<string>();
  private running = false;

  constructor(
    private readonly cfg: Config,
    private readonly manager: SessionManager,
  ) {
    this.source =
      cfg.scheduleSource === "gcal"
        ? new GoogleCalendarSource(cfg, logger)
        : new FileScheduleSource(cfg.scheduleFile!, logger);
    logger.info({ source: cfg.scheduleSource }, "scheduler initialized");
  }

  async start(): Promise<void> {
    this.running = true;
    const lookaheadMs = this.cfg.gcalLookaheadMin * 60_000;
    while (this.running) {
      try {
        const now = new Date();
        const due = await this.source.upcoming(now, lookaheadMs);
        for (const m of due) {
          if (this.handled.has(m.key) || this.manager.isActive(m.meetUrl)) continue;

          // Derive a max duration from the event end (+10 min buffer) if known.
          const maxDurationMin = m.endsAt
            ? Math.ceil((m.endsAt.getTime() - now.getTime()) / 60_000) + 10
            : undefined;

          try {
            const id = this.manager.start({ meetUrl: m.meetUrl, title: m.title, maxDurationMin });
            this.handled.add(m.key);
            logger.info({ id, title: m.title, meetUrl: m.meetUrl }, "scheduled recording started");
          } catch (err) {
            if (err instanceof CapacityError) {
              logger.warn({ title: m.title }, "skipping scheduled recording — at capacity");
            } else if (err instanceof DuplicateError) {
              this.handled.add(m.key);
            } else {
              logger.error({ err, title: m.title }, "failed to start scheduled recording");
            }
          }
        }
        // Forget keys for meetings that have clearly ended, so a re-used room
        // code on a later day can be recorded again.
        this.pruneHandled(now);
      } catch (err) {
        logger.error({ err }, "scheduler poll failed");
      }
      await sleep(this.cfg.schedulePollSec * 1000);
    }
  }

  stop(): void {
    this.running = false;
  }

  private pruneHandled(now: Date): void {
    for (const key of this.handled) {
      const iso = key.split("@")[1];
      if (iso) {
        const t = new Date(iso).getTime();
        // 12h after the listed start, the key is safe to forget.
        if (!Number.isNaN(t) && now.getTime() - t > 12 * 60 * 60 * 1000) this.handled.delete(key);
      }
    }
  }
}
