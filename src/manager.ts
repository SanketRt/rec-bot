import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { Session } from "./session.js";
import type { EndReason, RecordingRequest } from "./types.js";
import { normalizeMeetUrl } from "./util.js";

export interface ActiveInfo {
  id: string;
  meetUrl: string;
  title?: string;
  startedAt: Date;
}

export class CapacityError extends Error {}
export class DuplicateError extends Error {}

/**
 * Owns the set of running sessions. Both the HTTP API and the scheduler funnel
 * through here so we enforce one global concurrency cap and never double-join
 * the same meeting from two triggers.
 */
export class SessionManager {
  private readonly active = new Map<string, { session: Session; info: ActiveInfo }>();

  constructor(private readonly cfg: Config) {}

  /** Key sessions by canonical meet URL so dup triggers collapse to one. */
  private key(meetUrl: string): string {
    return normalizeMeetUrl(meetUrl) ?? meetUrl;
  }

  list(): ActiveInfo[] {
    return [...this.active.values()].map((e) => e.info);
  }

  isActive(meetUrl: string): boolean {
    return this.active.has(this.key(meetUrl));
  }

  /**
   * Start a recording in the background. Returns the new session id.
   * Throws DuplicateError if that meeting is already recording, or
   * CapacityError if the concurrency cap is reached.
   */
  start(request: RecordingRequest): string {
    const key = this.key(request.meetUrl);
    if (this.active.has(key)) throw new DuplicateError(`already recording ${key}`);
    if (this.active.size >= this.cfg.maxConcurrent) {
      throw new CapacityError(`at capacity (${this.cfg.maxConcurrent} concurrent recordings)`);
    }

    const session = new Session(request, this.cfg);
    this.active.set(key, {
      session,
      info: { id: session.id, meetUrl: key, title: request.title, startedAt: new Date() },
    });

    session
      .run()
      .then((res) => logger.info({ id: session.id, endReason: res.endReason }, "session finished"))
      .catch((err) => logger.error({ id: session.id, err: String(err) }, "session errored"))
      .finally(() => this.active.delete(key));

    return session.id;
  }

  /** Stop one session by id, or all if no id is given. */
  stop(id?: string, reason: EndReason = "manual-stop"): number {
    let stopped = 0;
    for (const { session } of this.active.values()) {
      if (!id || session.id === id) {
        session.requestStop(reason);
        stopped++;
      }
    }
    return stopped;
  }

  /** Wait for all active sessions to wind down (used on graceful shutdown). */
  async drain(timeoutMs = 60_000): Promise<void> {
    this.stop(undefined, "manual-stop");
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
