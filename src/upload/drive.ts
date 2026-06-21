import { execa } from "execa";
import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { RecordingResult } from "../types.js";
import type { Uploader } from "./index.js";

/**
 * Uploads to Google Drive (or any rclone remote) via the `rclone` binary.
 * rclone gives us resumable, chunked, retrying transfers for free — far more
 * robust than a raw HTTP upload for multi-GB lecture files.
 *
 * Configure with: RCLONE_REMOTE="gdrive:ANCC/recordings" and a mounted/baked
 * rclone.conf (see README). The transcript, if any, is uploaded alongside.
 */
export class RcloneDriveUploader implements Uploader {
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  async upload(result: RecordingResult): Promise<string> {
    const remote = this.cfg.rcloneRemote;
    if (!remote) throw new Error("RCLONE_REMOTE is not set for drive upload");

    const files = [result.outputPath, result.transcriptPath].filter(Boolean) as string[];
    for (const file of files) {
      this.log.info({ file, remote }, "rclone copy -> drive");
      await execa(
        "rclone",
        ["copy", file, remote, "--transfers", "1", "--drive-chunk-size", "64M", "--stats", "10s"],
        { stdio: "inherit" },
      );
    }
    return `${remote}/${path.basename(result.outputPath)}`;
  }
}
