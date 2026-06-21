import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { RecordingResult } from "../types.js";
import { LocalUploader } from "./local.js";
import { RcloneDriveUploader } from "./drive.js";
import { YouTubeUploader } from "./youtube.js";

export interface Uploader {
  /** Upload (or otherwise publish) the finished recording. Returns a location string. */
  upload(result: RecordingResult): Promise<string | undefined>;
}

class NoopUploader implements Uploader {
  async upload(): Promise<undefined> {
    return undefined;
  }
}

/** Pick the uploader implementation from config. */
export function createUploader(cfg: Config, log: Logger): Uploader {
  switch (cfg.uploadTarget) {
    case "none":
      return new NoopUploader();
    case "local":
      return new LocalUploader(log);
    case "drive":
      return new RcloneDriveUploader(cfg, log);
    case "youtube":
      return new YouTubeUploader(cfg, log);
    default:
      return new LocalUploader(log);
  }
}
