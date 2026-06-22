import express, { type NextFunction, type Request, type Response } from "express";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { CapacityError, DuplicateError, type SessionManager } from "./manager.js";
import { normalizeMeetUrl } from "./util.js";
import type { RecordingRequest } from "./types.js";
import { INDEX_HTML } from "./ui.js";

const LAYOUTS = ["spotlight", "auto", "tiled", "sidebar"] as const;

/**
 * Control plane: a small JSON API plus a single-page web UI at `/`.
 *
 *   GET  /            -> the control web UI
 *   GET  /health      -> liveness + active count
 *   GET  /recordings  -> active sessions
 *   GET  /history     -> finished recordings on disk
 *   POST /record      -> start a recording now (202 + {id})
 *   POST /stop {id?}  -> stop one (or all) sessions
 *
 * If API_TOKEN is set, every route except `/` and `/health` requires
 * `Authorization: Bearer <token>`.
 */
export function createApp(cfg: Config, manager: SessionManager) {
  const app = express();
  app.use(express.json());

  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.apiToken) return next();
    const header = req.header("authorization") ?? "";
    if (header === `Bearer ${cfg.apiToken}`) return next();
    res.status(401).json({ error: "unauthorized" });
  };

  app.get("/", (_req, res) => res.type("html").send(INDEX_HTML));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      active: manager.list().length,
      maxConcurrent: cfg.maxConcurrent,
      authRequired: !!cfg.apiToken,
    });
  });

  app.get("/recordings", auth, (_req, res) => {
    res.json({ active: manager.list() });
  });

  app.get("/history", auth, async (_req, res) => {
    try {
      const dir = cfg.outputDir!;
      const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".mp4"));
      const files = [];
      for (const name of names) {
        const s = await stat(path.join(dir, name)).catch(() => null);
        if (s) files.push({ name, sizeMB: +(s.size / 1048576).toFixed(1), mtime: s.mtimeMs });
      }
      files.sort((a, b) => b.mtime - a.mtime);
      res.json({ files: files.slice(0, 50) });
    } catch {
      res.json({ files: [] });
    }
  });

  app.post("/record", auth, (req, res) => {
    const body = req.body ?? {};
    const { meetUrl, title, maxDurationMin, botName, layout, hideSelfView, dismissPopups } = body;
    if (typeof meetUrl !== "string" || !normalizeMeetUrl(meetUrl)) {
      return res.status(400).json({ error: "meetUrl must be a valid Google Meet link" });
    }
    if (layout !== undefined && !LAYOUTS.includes(layout)) {
      return res.status(400).json({ error: `layout must be one of ${LAYOUTS.join(", ")}` });
    }
    const request: RecordingRequest = {
      meetUrl,
      title: typeof title === "string" && title.trim() ? title.trim() : undefined,
      maxDurationMin: Number.isFinite(maxDurationMin) ? Number(maxDurationMin) : undefined,
      botName: typeof botName === "string" && botName.trim() ? botName.trim() : undefined,
      layout,
      hideSelfView: typeof hideSelfView === "boolean" ? hideSelfView : undefined,
      dismissPopups: typeof dismissPopups === "boolean" ? dismissPopups : undefined,
    };
    try {
      const id = manager.start(request);
      logger.info({ id, meetUrl }, "recording started via API");
      res.status(202).json({ id, meetUrl: normalizeMeetUrl(meetUrl) });
    } catch (err) {
      if (err instanceof DuplicateError) return res.status(409).json({ error: err.message });
      if (err instanceof CapacityError) return res.status(429).json({ error: err.message });
      logger.error({ err }, "failed to start recording");
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/stop", auth, (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id : undefined;
    const stopped = manager.stop(id);
    res.json({ stopped });
  });

  return app;
}
