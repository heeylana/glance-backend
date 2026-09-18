import { env } from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[env.LOG_LEVEL];

function emit(level: Level, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg, ...(data ?? {}) };
  const out = JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (level === "error" || level === "warn") process.stderr.write(out + "\n");
  else process.stdout.write(out + "\n");
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
};
