import { execa } from "execa";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { ensureDir } from "../util.js";

async function ffprobeDuration(file: string): Promise<number> {
  const { stdout } = await execa("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const d = Number.parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : 0;
}

interface SilenceInterval {
  start: number;
  end: number;
}

/** Run ffmpeg silencedetect and parse the reported silent intervals. */
async function detectSilence(file: string, log: Logger): Promise<SilenceInterval[]> {
  const { stderr } = await execa(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-40dB:d=2", "-f", "null", "-"],
    { reject: false },
  );
  const intervals: SilenceInterval[] = [];
  let start: number | undefined;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) start = Number.parseFloat(s[1]!);
    if (e && start !== undefined) {
      intervals.push({ start, end: Number.parseFloat(e[1]!) });
      start = undefined;
    }
  }
  // A silence that runs to EOF has a start but no matching end.
  if (start !== undefined) intervals.push({ start, end: Number.POSITIVE_INFINITY });
  log.debug({ intervals }, "detected silence intervals");
  return intervals;
}

/**
 * Compute [trimStart, trimEnd] that removes only *leading* and *trailing* dead
 * air, with a small pad. Returns null if there's nothing worth trimming.
 */
function computeTrim(
  intervals: SilenceInterval[],
  duration: number,
  log: Logger,
): { start: number; end: number } | null {
  const PAD = 0.4;
  let trimStart = 0;
  let trimEnd = duration;

  const lead = intervals.find((i) => i.start <= 0.6 && Number.isFinite(i.end));
  if (lead) trimStart = Math.max(0, lead.end - PAD);

  const tail = intervals.find((i) => i.end === Number.POSITIVE_INFINITY || i.end >= duration - 0.6);
  if (tail) trimEnd = Math.min(duration, tail.start + PAD);

  if (trimEnd - trimStart < 2 || (trimStart < 1 && duration - trimEnd < 1)) return null;
  log.info({ trimStart: +trimStart.toFixed(1), trimEnd: +trimEnd.toFixed(1), duration }, "trimming dead air");
  return { start: trimStart, end: trimEnd };
}

/**
 * Turn the raw .mkv capture into the final, distributable .mp4:
 *   - optional silence trim (leading/trailing only),
 *   - optional EBU R128 loudness normalization (consistent volume),
 *   - video stream copied (no re-encode -> fast),
 *   - +faststart so it streams/seeks instantly.
 */
export async function finalize(
  rawPath: string,
  outputPath: string,
  cfg: Config,
  log: Logger,
): Promise<void> {
  await ensureDir(path.dirname(outputPath));

  let trim: { start: number; end: number } | null = null;
  if (cfg.trimSilence) {
    try {
      const [duration, intervals] = await Promise.all([
        ffprobeDuration(rawPath),
        detectSilence(rawPath, log),
      ]);
      trim = computeTrim(intervals, duration, log);
    } catch (err) {
      log.warn({ err }, "silence analysis failed; skipping trim");
    }
  }

  const args: string[] = ["-hide_banner", "-loglevel", "warning", "-y"];
  if (trim) args.push("-ss", trim.start.toFixed(2));
  args.push("-i", rawPath);
  if (trim) args.push("-to", (trim.end - trim.start).toFixed(2)); // -to is relative when -ss precedes -i

  // Video: copy (fast). Audio: re-encode only if normalizing, else copy.
  args.push("-c:v", "copy");
  if (cfg.postprocess) {
    args.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", cfg.audioBitrate!, "-ar", "48000");
  } else {
    args.push("-c:a", "copy");
  }
  args.push("-movflags", "+faststart", outputPath);

  log.info({ outputPath, normalize: cfg.postprocess, trim: !!trim }, "finalizing recording");
  const res = await execa("ffmpeg", args, { reject: false });
  if (res.exitCode !== 0) {
    // Fall back to a plain remux so we never lose the recording.
    log.warn({ stderr: res.stderr?.slice(-500) }, "finalize failed; falling back to plain remux");
    await execa("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-y",
      "-i",
      rawPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  }
  log.info({ outputPath }, "final recording written");
}

/**
 * Generate a transcript with OpenAI Whisper (or a compatible CLI). Best-effort:
 * logs and returns undefined if the binary is missing or fails.
 */
export async function transcribe(
  mediaPath: string,
  cfg: Config,
  log: Logger,
): Promise<string | undefined> {
  if (!cfg.transcribe) return undefined;
  const outDir = path.dirname(mediaPath);
  const base = path.basename(mediaPath, path.extname(mediaPath));
  try {
    log.info({ model: cfg.whisperModel }, "transcribing with whisper");
    await execa(cfg.whisperBin!, [
      mediaPath,
      "--model",
      cfg.whisperModel!,
      "--output_format",
      "srt",
      "--output_dir",
      outDir,
      "--language",
      "en",
    ]);
    const transcriptPath = path.join(outDir, `${base}.srt`);
    log.info({ transcriptPath }, "transcript written");
    return transcriptPath;
  } catch (err) {
    log.warn({ err }, "transcription failed (is whisper installed?); skipping");
    return undefined;
  }
}

/** Remove the raw intermediate capture. */
export async function cleanupRaw(rawPath: string, log: Logger): Promise<void> {
  try {
    await rm(rawPath, { force: true });
    log.debug({ rawPath }, "removed raw capture");
  } catch (err) {
    log.debug({ err }, "could not remove raw capture");
  }
}
