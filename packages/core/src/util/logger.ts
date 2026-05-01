/**
 * Tiny structured logger. Levels via P2P_LOG_LEVEL env var (debug|info|warn|error).
 * Output format: `[level] [scope] message {json-context}`
 */
type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const raw = (process.env.P2P_LOG_LEVEL ?? "info").toLowerCase();
  if (raw in ORDER) return raw as Level;
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
