export const LOG_LEVEL_VALUES = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVEL_VALUES)[number];
