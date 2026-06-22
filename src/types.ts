/** Shared domain types for the recorder. */

export interface RecordingRequest {
  /** Google Meet URL, e.g. https://meet.google.com/abc-defg-hij */
  meetUrl: string;
  /** Human-friendly label used in the output filename (e.g. "algorithms-lec-3"). */
  title?: string;
  /**
   * Hard cap in minutes. The bot leaves and finalizes when reached regardless
   * of participants. Falls back to config default when omitted.
   */
  maxDurationMin?: number;
  /** Display name the bot shows in the participant list. */
  botName?: string;
  /** Meet layout to apply for this recording (overrides config default). */
  layout?: "spotlight" | "auto" | "tiled" | "sidebar";
  /** Hide the bot's own self-view tile (best-effort; overrides config default). */
  hideSelfView?: boolean;
  /** Auto-dismiss in-call popups (overrides config default). */
  dismissPopups?: boolean;
}

export interface RecordingResult {
  request: RecordingRequest;
  /** Absolute path to the finalized (post-processed) recording. */
  outputPath: string;
  /** Absolute path to the raw capture before post-processing. */
  rawPath: string;
  /** Path to the transcript file, when transcription is enabled. */
  transcriptPath?: string;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  /** Why the session ended. */
  endReason: EndReason;
  /** Destination URI/path after upload (local path, Drive id, or YouTube URL). */
  uploadedTo?: string;
}

export type EndReason =
  | "meeting-empty"
  | "max-duration"
  | "removed-from-meeting"
  | "manual-stop"
  | "join-failed"
  | "browser-crashed"
  | "error";

export interface MeetingState {
  /** Best-effort participant count from the Meet UI (includes the bot). */
  participantCount: number;
  /** True while the bot is still admitted to the call. */
  inMeeting: boolean;
  /** True when someone is sharing their screen. */
  screenShareActive: boolean;
}
