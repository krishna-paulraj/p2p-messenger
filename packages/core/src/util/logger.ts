/**
 * Tiny structured logger. Levels via P2P_LOG_LEVEL env var (debug|info|warn|error).
 * Output format: `[level] [scope] message {json-context}`
 */
type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  // Avoid touching `process.env` in the browser — `process` is not defined
  // there and would throw at module load time. Fall back to "warn" so the
  // browser console isn't spammed with info chatter from protocol modules.
  let raw: string | undefined;
  if (typeof globalThis !== "undefined" && typeof (globalThis as { process?: { env?: Record<string, string | undefined> } }).process !== "undefined") {
    raw = (globalThis as { process: { env: Record<string, string | undefined> } }).process.env?.P2P_LOG_LEVEL;
  }
  const normalized = (raw ?? (typeof window === "undefined" ? "info" : "warn")).toLowerCase();
  if (normalized in ORDER) return normalized as Level;
  return "info";
}

let activeLevel: Level = envLevel();

export function setLogLevel(level: Level): void {
  activeLevel = level;
}

function emit(level: Level, scope: string, msg: string, ctx?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[activeLevel]) return;
  const tail = ctx ? ` ${JSON.stringify(ctx)}` : "";
  const line = `[${level}] [${scope}] ${msg}${tail}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export type Logger = {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(subScope: string): Logger;
};

export function makeLogger(scope: string): Logger {
  return {
    debug: (m, c) => emit("debug", scope, m, c),
    info: (m, c) => emit("info", scope, m, c),
    warn: (m, c) => emit("warn", scope, m, c),
    error: (m, c) => emit("error", scope, m, c),
    child: (sub) => makeLogger(`${scope}:${sub}`),
  };
}
