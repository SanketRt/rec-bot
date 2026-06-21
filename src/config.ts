import { z } from "zod";

/** Coerce common truthy strings to boolean. */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : Number.parseFloat(v)))
    .pipe(z.number());

const str = (def?: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v));

const ConfigSchema = z.object({
  // --- Display / capture ---------------------------------------------------
  display: str(":99"),
  screenWidth: int(1920),
  screenHeight: int(1080),
  framerate: int(30),
  videoCrf: int(23),
  videoPreset: str("veryfast"),
  audioBitrate: str("192k"),
  pulseSink: str("rec_bot_sink"),

  // --- Browser / identity --------------------------------------------------
  botName: str("ANCC Recording"),
  chromeUserDataDir: str("/data/chrome-profile"),
  chromeExecutable: str(), // optional override; defaults to Playwright's Chromium
  browserChannel: str(), // e.g. "chrome" to use real Google Chrome (dodges Meet's bot block)

  // --- Framing -------------------------------------------------------------
  layout: z
    .enum(["spotlight", "auto", "tiled", "sidebar"])
    .or(z.undefined())
    .transform((v) => v ?? "spotlight"), // spotlight = only the active speaker/share fills the frame
  dismissPopups: bool(true), // auto-close in-call popups (Gemini notes, tips, etc.)
  googleEmail: str(),
  googlePassword: str(),

  // --- Session lifecycle ---------------------------------------------------
  maxDurationMin: int(180),
  joinTimeoutSec: int(120), // how long to wait in the lobby for admission
  emptyThreshold: int(1), // <= this many participants counts as "empty" (just the bot)
  emptyGraceSec: int(90), // must remain empty this long before leaving
  startGraceSec: int(300), // ignore "empty" for this long after joining (late lecturer)
  heartbeatIntervalSec: int(10),

  // --- Paths ---------------------------------------------------------------
  outputDir: str("/data/recordings"),
  workDir: str("/data/work"),
  logDir: str("/data/logs"),

  // --- Post-processing -----------------------------------------------------
  postprocess: bool(true), // EBU R128 loudness normalization
  trimSilence: bool(true), // trim leading/trailing silence
  transcribe: bool(false),
  whisperBin: str("whisper"),
  whisperModel: str("base"),

  // --- Upload --------------------------------------------------------------
  uploadTarget: z
    .enum(["none", "local", "drive", "youtube"])
    .or(z.undefined())
    .transform((v) => v ?? "local"),
  deleteAfterUpload: bool(false),
  rcloneRemote: str(), // e.g. "gdrive:ANCC/recordings"
  youtubePrivacy: z
    .enum(["private", "unlisted", "public"])
    .or(z.undefined())
    .transform((v) => v ?? "unlisted"),

  // --- Google OAuth (YouTube upload + Google Calendar) ---------------------
  googleClientId: str(),
  googleClientSecret: str(),
  googleRefreshToken: str(),

  // --- HTTP API ------------------------------------------------------------
  port: int(8080),
  apiToken: str(), // optional bearer token; if set, required on the API
  maxConcurrent: int(2), // cap simultaneous recordings (RAM/CPU bound)

  // --- Scheduler -----------------------------------------------------------
  scheduleSource: z
    .enum(["file", "gcal"])
    .or(z.undefined())
    .transform((v) => v ?? "file"),
  scheduleFile: str("/data/schedule.json"),
  schedulePollSec: int(30),
  gcalCalendarId: str("primary"),
  gcalLookaheadMin: int(2), // join this many minutes before event start

  // --- Misc ----------------------------------------------------------------
  nodeEnv: str("production"),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadEnv(): Record<string, string | undefined> {
  return {
    display: process.env.DISPLAY,
    screenWidth: process.env.SCREEN_WIDTH,
    screenHeight: process.env.SCREEN_HEIGHT,
    framerate: process.env.FRAMERATE,
    videoCrf: process.env.VIDEO_CRF,
    videoPreset: process.env.VIDEO_PRESET,
    audioBitrate: process.env.AUDIO_BITRATE,
    pulseSink: process.env.PULSE_SINK,
    botName: process.env.BOT_NAME,
    chromeUserDataDir: process.env.CHROME_USER_DATA_DIR,
    chromeExecutable: process.env.CHROME_EXECUTABLE,
    browserChannel: process.env.BROWSER_CHANNEL,
    layout: process.env.LAYOUT,
    dismissPopups: process.env.DISMISS_POPUPS,
    googleEmail: process.env.GOOGLE_EMAIL,
    googlePassword: process.env.GOOGLE_PASSWORD,
    maxDurationMin: process.env.MAX_DURATION_MIN,
    joinTimeoutSec: process.env.JOIN_TIMEOUT_SEC,
    emptyThreshold: process.env.EMPTY_THRESHOLD,
    emptyGraceSec: process.env.EMPTY_GRACE_SEC,
    startGraceSec: process.env.START_GRACE_SEC,
    heartbeatIntervalSec: process.env.HEARTBEAT_INTERVAL_SEC,
    outputDir: process.env.OUTPUT_DIR,
    workDir: process.env.WORK_DIR,
    logDir: process.env.LOG_DIR,
    postprocess: process.env.POSTPROCESS,
    trimSilence: process.env.TRIM_SILENCE,
    transcribe: process.env.TRANSCRIBE,
    whisperBin: process.env.WHISPER_BIN,
    whisperModel: process.env.WHISPER_MODEL,
    uploadTarget: process.env.UPLOAD_TARGET,
    deleteAfterUpload: process.env.DELETE_AFTER_UPLOAD,
    rcloneRemote: process.env.RCLONE_REMOTE,
    youtubePrivacy: process.env.YOUTUBE_PRIVACY,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    port: process.env.PORT,
    apiToken: process.env.API_TOKEN,
    maxConcurrent: process.env.MAX_CONCURRENT,
    scheduleSource: process.env.SCHEDULE_SOURCE,
    scheduleFile: process.env.SCHEDULE_FILE,
    schedulePollSec: process.env.SCHEDULE_POLL_SEC,
    gcalCalendarId: process.env.GCAL_CALENDAR_ID,
    gcalLookaheadMin: process.env.GCAL_LOOKAHEAD_MIN,
    nodeEnv: process.env.NODE_ENV,
  };
}

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(loadEnv());
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
