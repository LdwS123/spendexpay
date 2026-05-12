/**
 * Structured logging helper for Spendex Pay dashboard.
 *
 * Emits single-line JSON records on stderr (process.stderr.write) so log
 * aggregators (Vercel, Fly, Datadog, ...) can parse them. This is a drop-in
 * helper for *new* code paths — existing console.error calls are intentionally
 * left untouched per CLAUDE.md guidance.
 *
 *   log.info("user_login", { user_id: "u_123" });
 *   log.warn("rate_limit_hit", { token: "..." });
 *   log.error("payment_failed", { intent: "pi_..." }, err);
 */

type LogLevel = "info" | "warn" | "error";

type LogData = Record<string, unknown>;

const SERVICE = "spendex-dashboard";
const VERSION = "0.1.0";

function serializeError(err: unknown): LogData {
  if (err instanceof Error) {
    return {
      error_name: err.name,
      error_message: err.message,
      error_stack: err.stack,
    };
  }
  if (typeof err === "string") {
    return { error_message: err };
  }
  return { error_message: String(err) };
}

function emit(level: LogLevel, event: string, data?: LogData, err?: unknown): void {
  const record: LogData = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    version: VERSION,
    event,
    ...(data ?? {}),
  };

  if (err !== undefined) {
    Object.assign(record, serializeError(err));
  }

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // Fallback if record contains circular refs etc.
    line = JSON.stringify({
      ts: record.ts,
      level,
      service: SERVICE,
      version: VERSION,
      event,
      log_serialize_error: true,
    });
  }

  // stderr only — never pollute stdout (matches the MCP server discipline).
  process.stderr.write(line + "\n");
}

export const log = {
  info(event: string, data?: LogData): void {
    emit("info", event, data);
  },
  warn(event: string, data?: LogData): void {
    emit("warn", event, data);
  },
  error(event: string, data?: LogData, err?: unknown): void {
    emit("error", event, data, err);
  },
};

export type Logger = typeof log;
