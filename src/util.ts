import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turn an arbitrary label into a safe filename fragment. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80) || "recording"
  );
}

/** Local timestamp like 2026-06-20_15-42-07, safe for filenames. */
export function fileTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function newSessionId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Normalize / validate a Google Meet URL. Accepts bare codes ("abc-defg-hij")
 * and full URLs; returns a canonical https URL or null if it isn't a Meet link.
 */
export function normalizeMeetUrl(input: string): string | null {
  const trimmed = input.trim();
  const bareCode = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
  if (bareCode.test(trimmed)) return `https://meet.google.com/${trimmed.toLowerCase()}`;
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    if (url.hostname !== "meet.google.com") return null;
    // strip query/hash that can confuse the join page, keep the path code
    const code = url.pathname.replace(/^\/+/, "").split("/")[0];
    if (!code) return null;
    return `https://meet.google.com/${code}`;
  } catch {
    return null;
  }
}

/** Retry an async op with fixed delay. Throws the last error if all attempts fail. */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; delayMs: number; onRetry?: (err: unknown, attempt: number) => void },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < opts.attempts) {
        opts.onRetry?.(err, attempt);
        await sleep(opts.delayMs);
      }
    }
  }
  throw lastErr;
}
