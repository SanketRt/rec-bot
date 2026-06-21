/** A meeting the scheduler should record, from any source (file or calendar). */
export interface ScheduledMeeting {
  /** Stable identity for dedup across polls (e.g. calendar event id + start). */
  key: string;
  meetUrl: string;
  title: string;
  startsAt: Date;
  /** Optional end time; used to derive a max duration and to stop joining late. */
  endsAt?: Date;
}

export interface ScheduleSource {
  /** Meetings starting within the lookahead window. */
  upcoming(now: Date, lookaheadMs: number): Promise<ScheduledMeeting[]>;
}
