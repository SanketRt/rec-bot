import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { CapacityError, DuplicateError, type SessionManager } from "./manager.js";
import { normalizeMeetUrl } from "./util.js";

/**
 * Minimal control-plane API.
 *
 *   GET  /health              -> liveness + active count
 *   GET  /recordings          -> list active sessions
 *   POST /record  {meetUrl,…} -> start a recording now (202 + {id})
 *   POST /stop    {id?}       -> stop one (or all) sessions
 *
 * If API_TOKEN is set, every route except /health requires
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

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", active: manager.list().length, maxConcurrent: cfg.maxConcurrent });
  });

  app.get("/recordings", auth, (_req, res) => {
    res.json({ active: manager.list() });
  });

  app.post("/record", auth, (req, res) => {
    const { meetUrl, title, maxDurationMin, botName } = req.body ?? {};
    if (typeof meetUrl !== "string" || !normalizeMeetUrl(meetUrl)) {
      return res.status(400).json({ error: "meetUrl must be a valid Google Meet link" });
    }
    try {
      const id = manager.start({ meetUrl, title, maxDurationMin, botName });
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
