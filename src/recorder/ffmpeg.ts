import { execa, type ResultPromise } from "execa";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { ensureDir, sleep } from "../util.js";

/**
 * Captures the virtual display (video) + the PulseAudio sink monitor (audio)
 * into a single file via a long-running ffmpeg process.
 *
 * Design choices that make the capture robust:
 *  - We record to **Matroska (.mkv)**, which stays playable even if the process
 *    is killed mid-write (unlike a non-faststart .mp4 whose moov atom is only
 *    written on clean exit). Post-processing remuxes to .mp4 afterwards.
 *  - We capture the sink **monitor**, i.e. the mixed digital output of the call,
 *    so there is zero room noise and nothing depends on a physical microphone.
 *  - Stopping sends `q` on stdin for a clean finalize; we escalate to signals
 *    only if ffmpeg ignores it.
 */
export class Recorder {
  readonly rawPath: string;
  private proc?: ResultPromise;
  private logStream?: WriteStream;
  private stopped = false;
  private finished = false;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    rawBaseName: string,
  ) {
    this.rawPath = path.join(cfg.workDir!, `${rawBaseName}.mkv`);
  }

  async start(): Promise<void> {
    await ensureDir(this.cfg.workDir!);
    await ensureDir(this.cfg.logDir!);

    const { display, screenWidth, screenHeight, framerate, videoCrf, videoPreset, audioBitrate, pulseSink } =
      this.cfg;

    // NB: stdin stays open (piped) so we can send 'q' for a clean finalize.
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      // ---- video: grab the X display ----
      "-thread_queue_size",
      "1024",
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      "-framerate",
      String(framerate),
      "-video_size",
      `${screenWidth}x${screenHeight}`,
      "-i",
      display!,
      // ---- audio: grab the null-sink monitor ----
      "-thread_queue_size",
      "1024",
      "-f",
      "pulse",
      "-i",
      `${pulseSink}.monitor`,
      // ---- video encode ----
      "-c:v",
      "libx264",
      "-preset",
      videoPreset!,
      "-crf",
      String(videoCrf),
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(framerate * 2), // keyframe every 2s -> precise-ish trims & seeking
      // ---- audio encode ----
      "-c:a",
      "aac",
      "-b:a",
      audioBitrate!,
      "-ar",
      "48000",
      "-ac",
      "2",
      this.rawPath,
    ];

    this.log.info({ rawPath: this.rawPath }, "starting ffmpeg capture");
    this.log.debug({ cmd: `ffmpeg ${args.join(" ")}` }, "ffmpeg args");

    const logStream = createWriteStream(path.join(this.cfg.logDir!, "ffmpeg.log"), { flags: "a" });
    this.logStream = logStream;
    // A log-file problem (e.g. permissions) must never crash a recording — drop
    // the side log and keep capturing.
    logStream.on("error", (err) => {
      this.log.warn({ err }, "ffmpeg log file unwritable; continuing without it");
      this.logStream = undefined;
    });

    this.proc = execa("ffmpeg", args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
    });
    this.proc.stdout?.pipe(logStream, { end: false });
    this.proc.stderr?.pipe(logStream, { end: false });
    // Track completion without relying on the live ChildProcess.exitCode.
    void this.proc.then(() => {
      this.finished = true;
    });

    // Detect early failure (bad display, missing sink) within the first ~3s.
    const earlyExit = await Promise.race([
      this.proc.then(() => "exited" as const),
      sleep(3000).then(() => "running" as const),
    ]);
    if (earlyExit === "exited") {
      throw new Error(`ffmpeg exited immediately — check display/sink. See ffmpeg.log`);
    }
    this.log.info("ffmpeg capture running");
  }

  /** Cleanly stop the capture and wait for the file to be finalized. */
  async stop(): Promise<void> {
    if (this.stopped || !this.proc) return;
    this.stopped = true;
    this.log.info("stopping ffmpeg (sending q)");
    try {
      this.proc.stdin?.write("q");
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }

    const exited = await Promise.race([
      this.proc.then(() => true),
      sleep(10_000).then(() => false),
    ]);
    if (!exited) {
      this.log.warn("ffmpeg did not exit on 'q', sending SIGTERM");
      this.proc.kill("SIGTERM");
      const term = await Promise.race([this.proc.then(() => true), sleep(5000).then(() => false)]);
      if (!term) {
        this.log.warn("ffmpeg ignored SIGTERM, sending SIGKILL");
        this.proc.kill("SIGKILL");
        await this.proc.catch(() => {});
      }
    }
    this.logStream?.end();
    this.log.info({ rawPath: this.rawPath }, "ffmpeg stopped, capture finalized");
  }

  /** True while the capture process is alive. */
  get isRunning(): boolean {
    return !!this.proc && !this.finished && !this.stopped;
  }
}
