import pino from "pino";

/**
 * Paths pino will redact wherever they appear in logged objects.
 * This is enforced at the logger level (not left to call-sites) so a
 * forgotten `log.info({ password })` somewhere can't leak a secret —
 * see spec requirement: never log passwords/raw API keys/JWT secrets.
 */
const REDACT_PATHS = [
  "password",
  "*.password",
  "req.headers.authorization",
  "*.authorization",
  "apiKey",
  "*.apiKey",
  "rawApiKey",
  "*.rawApiKey",
  "jwtSecret",
  "*.jwtSecret",
  "token",
  "*.token",
];

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  pretty?: boolean;
}

export function createLogger(opts: CreateLoggerOptions) {
  const { name, level = process.env.LOG_LEVEL ?? "info", pretty = process.env.NODE_ENV !== "production" } = opts;

  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    transport: pretty
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
        }
      : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
