import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const pretty = process.env.LOG_PRETTY === "1" || process.env.NODE_ENV !== "production";

/**
 * Structured logger. In dev it pretty-prints; in production it emits JSON lines
 * so they can be shipped to a log aggregator or `docker logs`.
 */
export const logger = pino(
  pretty
    ? {
        level,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : { level },
);

export type Logger = typeof logger;

/** Child logger scoped to a single recording session. */
export function sessionLogger(sessionId: string): Logger {
  return logger.child({ sessionId });
}
