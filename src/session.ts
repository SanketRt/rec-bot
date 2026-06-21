import path from "node:path";
import type { Config } from "./config.js";
import { sessionLogger, type Logger } from "./logger.js";
import type { EndReason, RecordingRequest, RecordingResult } from "./types.js";
import { newSessionId, slugify, fileTimestamp, ensureDir, sleep, normalizeMeetUrl } from "./util.js";
import { launchBrowser, type BrowserHandle } from "./bot/browser.js";
import { joinMeeting, leaveMeeting, JoinError } from "./bot/join.js";
import { dismissPopups, applyLayout } from "./bot/stage.js";
import { readMeetingState } from "./bot/monitor.js";
import { isVisible } from "./bot/selectors.js";
import { Recorder } from "./recorder/ffmpeg.js";
import { finalize, transcribe, cleanupRaw } from "./recorder/postprocess.js";
import { createUploader } from "./upload/index.js";

export class SessionError extends Error {
  constructor(message: string, readonly endReason: EndReason) {
    super(message);
    this.name = "SessionError";
  }
}

/**
 * One recording from start to finish: launch browser -> join -> capture ->
 * watch the room -> leave -> post-process -> (optionally) transcribe -> upload.
 *
 * The session is the unit the scheduler and API spawn. It owns graceful
 * shutdown so a SIGTERM or an external stop request always finalizes a playable
 * file instead of corrupting it.
 */
export class Session {
  readonly id = newSessionId();
  readonly log: Logger;
  private readonly meetUrl: string;
  private stopReason: EndReason | undefined;
  private browser?: BrowserHandle;
  private recorder?: Recorder;

  constructor(
    private readonly request: RecordingRequest,
    private readonly cfg: Config,
  ) {
    const url = normalizeMeetUrl(request.meetUrl);
    if (!url) throw new SessionError(`not a valid Google Meet URL: ${request.meetUrl}`, "error");
    this.meetUrl = url;
    this.log = sessionLogger(this.id);
  }

  /** Ask the session to wind down cleanly at the next heartbeat. */
  requestStop(reason: EndReason = "manual-stop"): void {
    if (!this.stopReason) {
      this.stopReason = reason;
      this.log.info({ reason }, "stop requested");
    }
  }

  async run(): Promise<RecordingResult> {
    const maxDurationMin = this.request.maxDurationMin ?? this.cfg.maxDurationMin;
    const baseName = `${fileTimestamp()}_${slugify(this.request.title ?? this.meetUrl.split("/").pop()!)}_${this.id}`;
    await ensureDir(this.cfg.outputDir!);
    await ensureDir(this.cfg.workDir!);

    this.log.info({ meetUrl: this.meetUrl, baseName, maxDurationMin }, "session starting");

    // --- Join -------------------------------------------------------------
    this.browser = await launchBrowser(this.cfg, this.log);
    const page = this.browser.page;
    const botName = this.request.botName ?? this.cfg.botName!;

    try {
      await joinMeeting(page, this.meetUrl, botName, this.cfg, this.log);
    } catch (err) {
      await this.saveDebugShot(baseName, "join-failed");
      await this.browser.close();
      const reason: EndReason = err instanceof JoinError ? "join-failed" : "error";
      throw new SessionError(`join failed: ${(err as Error).message}`, reason);
    }

    // --- Prepare the stage: clear popups, frame just the content ----------
    if (this.cfg.dismissPopups) await dismissPopups(page, this.log).catch(() => {});
    await applyLayout(page, this.cfg.layout, this.log).catch(() => {});
    // Park the cursor over the video area so Meet's controls auto-hide and no
    // hover tooltips appear. (The cursor itself is never captured — ffmpeg uses
    // -draw_mouse 0 — but parking it keeps the toolbar from staying on screen.)
    await page.mouse
      .move(Math.floor(this.cfg.screenWidth / 2), Math.floor(this.cfg.screenHeight * 0.4))
      .catch(() => {});

    // --- Record -----------------------------------------------------------
    const startedAt = new Date();
    this.recorder = new Recorder(this.cfg, this.log, baseName);
    try {
      await this.recorder.start();
    } catch (err) {
      await leaveMeeting(page, this.log);
      await this.browser.close();
      throw new SessionError(`recorder failed to start: ${(err as Error).message}`, "error");
    }

    // Safety net: hard cap even if the watch loop wedges.
    const hardCap = setTimeout(() => this.requestStop("max-duration"), maxDurationMin * 60_000);

    const endReason = await this.watchLoop(startedAt, maxDurationMin);
    clearTimeout(hardCap);

    // --- Wind down (always finalize a playable file) ----------------------
    const endedAt = new Date();
    await leaveMeeting(page, this.log).catch(() => {});
    await this.recorder.stop();
    await this.browser.close();

    const rawPath = this.recorder.rawPath;
    const outputPath = path.join(this.cfg.outputDir!, `${baseName}.mp4`);
    await finalize(rawPath, outputPath, this.cfg, this.log);
    const transcriptPath = await transcribe(outputPath, this.cfg, this.log);
    await cleanupRaw(rawPath, this.log);

    const result: RecordingResult = {
      request: this.request,
      outputPath,
      rawPath,
      transcriptPath,
      startedAt,
      endedAt,
      durationSec: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
      endReason,
    };

    // --- Upload -----------------------------------------------------------
    try {
      const uploader = createUploader(this.cfg, this.log);
      result.uploadedTo = await uploader.upload(result);
      if (result.uploadedTo && this.cfg.deleteAfterUpload && this.cfg.uploadTarget !== "local") {
        await cleanupRaw(outputPath, this.log);
      }
    } catch (err) {
      this.log.error({ err }, "upload failed; file kept locally");
    }

    this.log.info(
      { endReason, durationSec: result.durationSec, outputPath, uploadedTo: result.uploadedTo },
      "session complete",
    );
    return result;
  }

  /** Heartbeat loop: returns the reason the session should end. */
  private async watchLoop(startedAt: Date, maxDurationMin: number): Promise<EndReason> {
    const page = this.browser!.page;
    const intervalMs = this.cfg.heartbeatIntervalSec * 1000;
    let emptySince: number | undefined;
    let missingCount = 0;
    let ticks = 0;

    while (true) {
      await sleep(intervalMs);
      if (this.stopReason) return this.stopReason;

      const elapsedSec = (Date.now() - startedAt.getTime()) / 1000;
      if (elapsedSec >= maxDurationMin * 60) return "max-duration";

      // Periodically clear popups that appear mid-call (every ~minute).
      if (this.cfg.dismissPopups && ++ticks % 6 === 0 && !page.isClosed()) {
        await dismissPopups(page, this.log).catch(() => {});
      }

      if (page.isClosed()) {
        this.log.warn("browser page closed unexpectedly");
        return "browser-crashed";
      }

      const state = await readMeetingState(page, this.log);

      // Detect removal / disconnect (allow a few transient misses).
      if (!state.inMeeting) {
        missingCount++;
        if (await isVisible(page, "removedNotice")) return "removed-from-meeting";
        if (missingCount >= 3) {
          this.log.warn("leave button gone for 3 checks — assuming disconnected");
          return "removed-from-meeting";
        }
      } else {
        missingCount = 0;
      }

      // Empty-room detection, with a startup grace period for late lecturers.
      const isEmpty = state.participantCount <= this.cfg.emptyThreshold;
      if (isEmpty && elapsedSec > this.cfg.startGraceSec) {
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= this.cfg.emptyGraceSec * 1000) {
          this.log.info({ participantCount: state.participantCount }, "room empty past grace — leaving");
          return "meeting-empty";
        }
      } else {
        emptySince = undefined;
      }

      this.log.debug(
        { elapsedSec: Math.round(elapsedSec), ...state, emptyForSec: emptySince ? Math.round((Date.now() - emptySince) / 1000) : 0 },
        "heartbeat",
      );
    }
  }

  private async saveDebugShot(baseName: string, tag: string): Promise<void> {
    try {
      const p = path.join(this.cfg.logDir!, `${baseName}_${tag}.png`);
      await ensureDir(this.cfg.logDir!);
      await this.browser?.page.screenshot({ path: p, fullPage: false });
      this.log.warn({ screenshot: p }, "saved debug screenshot");
    } catch {
      /* ignore */
    }
  }
}
