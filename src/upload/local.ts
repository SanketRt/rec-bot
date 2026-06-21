import type { Logger } from "../logger.js";
import type { RecordingResult } from "../types.js";
import type { Uploader } from "./index.js";

/** The recording already lives in OUTPUT_DIR; just report its path. */
export class LocalUploader implements Uploader {
  constructor(private readonly log: Logger) {}

  async upload(result: RecordingResult): Promise<string> {
    this.log.info({ path: result.outputPath }, "recording kept locally");
    return result.outputPath;
  }
}
