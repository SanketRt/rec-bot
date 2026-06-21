#!/usr/bin/env node
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { Session, SessionError } from "./session.js";
import { SessionManager } from "./manager.js";
import { createApp } from "./server.js";
import { Scheduler } from "./scheduler/scheduler.js";

/** Tiny flag parser: supports `--key value` and `--key=value`; rest are positional. */
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = "true";
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function installSignalHandlers(onShutdown: () => Promise<void>): void {
  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.warn({ sig }, "shutdown signal received — winding down");
      onShutdown()
        .then(() => process.exit(0))
        .catch((err) => {
          logger.error({ err }, "error during shutdown");
          process.exit(1);
        });
    });
  }
}

async function cmdRecord(args: ReturnType<typeof parseArgs>): Promise<void> {
  const cfg = getConfig();
  const meetUrl = args.positional[0] ?? args.flags.url;
  if (!meetUrl) {
    logger.error('usage: rec-bot record <meetUrl> [--title "Lecture 3"] [--max 120] [--name "ANCC Recording"]');
    process.exit(2);
  }
  const session = new Session(
    {
      meetUrl,
      title: args.flags.title,
      maxDurationMin: args.flags.max ? Number.parseInt(args.flags.max, 10) : undefined,
      botName: args.flags.name,
    },
    cfg,
  );
  // On a signal, only *request* a stop — let the awaited run() below finish
  // leaving, finalizing the MP4, and uploading before we exit. (Exiting from the
  // handler here would kill ffmpeg mid-finalize and lose the post-processing.)
  const stop = () => session.requestStop("manual-stop");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await session.run();
    logger.info({ outputPath: result.outputPath, uploadedTo: result.uploadedTo }, "done");
    process.exit(0);
  } catch (err) {
    if (err instanceof SessionError) {
      logger.error({ endReason: err.endReason, message: err.message }, "recording failed");
    } else {
      logger.error({ err }, "recording failed");
    }
    process.exit(1);
  }
}

async function cmdServe(): Promise<void> {
  const cfg = getConfig();
  const manager = new SessionManager(cfg);
  const app = createApp(cfg, manager);
  const server = app.listen(cfg.port, () => logger.info({ port: cfg.port }, "API listening"));
  installSignalHandlers(async () => {
    server.close();
    await manager.drain();
  });
}

async function cmdSchedule(withApi: boolean): Promise<void> {
  const cfg = getConfig();
  const manager = new SessionManager(cfg);
  const scheduler = new Scheduler(cfg, manager);

  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  if (withApi) {
    const app = createApp(cfg, manager);
    server = app.listen(cfg.port, () => logger.info({ port: cfg.port }, "API listening"));
  }

  installSignalHandlers(async () => {
    scheduler.stop();
    server?.close();
    await manager.drain();
  });

  logger.info("scheduler running");
  await scheduler.start();
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (command) {
    case "record":
      return cmdRecord(args);
    case "serve":
      return cmdServe();
    case "schedule":
      return cmdSchedule(false);
    case "all": // scheduler + API together (the usual long-running mode)
      return cmdSchedule(true);
    default:
      logger.error(`unknown command: ${command ?? "(none)"}\n` + "commands: record | serve | schedule | all");
      process.exit(2);
  }
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
