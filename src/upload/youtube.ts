import { createReadStream } from "node:fs";
import { google } from "googleapis";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { RecordingResult } from "../types.js";
import type { Uploader } from "./index.js";

/**
 * Uploads the recording to YouTube as an unlisted (by default) video using a
 * pre-authorized OAuth refresh token. See README for the one-time token setup.
 *
 * googleapis performs a resumable upload from the file stream, so a transient
 * network blip won't always fail the whole transfer. For very large or very
 * flaky links, the Drive (rclone) target is even more resilient.
 */
export class YouTubeUploader implements Uploader {
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  async upload(result: RecordingResult): Promise<string> {
    const { googleClientId, googleClientSecret, googleRefreshToken } = this.cfg;
    if (!googleClientId || !googleClientSecret || !googleRefreshToken) {
      throw new Error("YouTube upload needs GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN");
    }

    const auth = new google.auth.OAuth2(googleClientId, googleClientSecret);
    auth.setCredentials({ refresh_token: googleRefreshToken });
    const youtube = google.youtube({ version: "v3", auth });

    const title = (result.request.title ?? "ANCC Lecture Recording").slice(0, 95);
    const description =
      `Recorded automatically by ANCC rec-bot.\n` +
      `Date: ${result.startedAt.toISOString()}\n` +
      `Duration: ${Math.round(result.durationSec / 60)} min`;

    this.log.info({ title, privacy: this.cfg.youtubePrivacy }, "uploading to youtube");
    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description, categoryId: "27" /* Education */ },
        status: { privacyStatus: this.cfg.youtubePrivacy, selfDeclaredMadeForKids: false },
      },
      media: { body: createReadStream(result.outputPath) },
    });

    const id = res.data.id;
    if (!id) throw new Error("YouTube did not return a video id");
    const url = `https://youtu.be/${id}`;
    this.log.info({ url }, "youtube upload complete");
    return url;
  }
}
