// Structured JSON logger. Writes one JSON object per line to stdout
// (stderr for errors), suitable for ingestion by Loki/Datadog/CloudWatch.
//
// Use `logger.child({ component: "..." })` to scope fields onto every
// subsequent log line — avoids repeating { component } on every call.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [k: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function emit(
  level: LogLevel,
  msg: string,
  base: LogFields,
  fields: LogFields | undefined,
  minLevel: LogLevel,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const record: LogFields = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...base,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export function createLogger(
  base: LogFields = {},
  minLevel: LogLevel = "info",
): Logger {
  return {
    debug: (msg, fields) => emit("debug", msg, base, fields, minLevel),
    info: (msg, fields) => emit("info", msg, base, fields, minLevel),
    warn: (msg, fields) => emit("warn", msg, base, fields, minLevel),
    error: (msg, fields) => emit("error", msg, base, fields, minLevel),
    child: (extra) => createLogger({ ...base, ...extra }, minLevel),
  };
}

export const rootLogger: Logger = createLogger(
  {},
  (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info",
);
