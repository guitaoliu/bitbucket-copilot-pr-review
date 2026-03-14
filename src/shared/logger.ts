import pino from "pino";

import type { LogLevel } from "./types.ts";

export interface Logger {
	debug(message: string, ...details: unknown[]): void;
	info(message: string, ...details: unknown[]): void;
	warn(message: string, ...details: unknown[]): void;
	error(message: string, ...details: unknown[]): void;
	trace(message: string, ...details: unknown[]): void;
	json(message: string): void;
}

function isPrettyLoggingEnabled(): boolean {
	return process.stderr.isTTY && process.env.CI !== "true";
}

function createBaseLogger(level: LogLevel): pino.Logger {
	const options = {
		level,
		base: null,
		timestamp: pino.stdTimeFunctions.isoTime,
		formatters: {
			level(label: string) {
				return { level: label };
			},
		},
	} as const;

	if (isPrettyLoggingEnabled()) {
		return pino(
			options,
			pino.transport({
				target: "pino-pretty",
				options: {
					destination: 2,
					sync: true,
					colorize: true,
					ignore: "pid,hostname",
					translateTime: "SYS:standard",
				},
			}),
		);
	}

	return pino(options, pino.destination({ dest: 2, sync: true }));
}

function normalizeDetails(details: unknown[]): {
	context?: unknown;
	messageSuffix?: string;
} {
	if (details.length === 0) {
		return {};
	}

	if (details.length === 1) {
		const [detail] = details;
		if (typeof detail === "string") {
			return { messageSuffix: detail };
		}

		return { context: detail };
	}

	return { context: { details } };
}

export function createLogger(level: LogLevel): Logger {
	const baseLogger = createBaseLogger(level);
	const reasoningLogger = baseLogger.child({ stream: "copilot_reasoning" });
	const emit = (
		method: LogLevel,
		message: string,
		details: unknown[],
	): void => {
		const { context, messageSuffix } = normalizeDetails(details);
		const fullMessage = messageSuffix ? `${message} ${messageSuffix}` : message;
		if (context === undefined) {
			baseLogger[method](fullMessage);
			return;
		}

		baseLogger[method](context, fullMessage);
	};

	return {
		debug(message, ...details) {
			emit("debug", message, details);
		},
		info(message, ...details) {
			emit("info", message, details);
		},
		warn(message, ...details) {
			emit("warn", message, details);
		},
		error(message, ...details) {
			emit("error", message, details);
		},
		trace(message, ...details) {
			const { context, messageSuffix } = normalizeDetails(details);
			const fullMessage = messageSuffix
				? `${message} ${messageSuffix}`
				: message;
			if (context === undefined) {
				reasoningLogger.info(fullMessage);
				return;
			}

			reasoningLogger.info(context, fullMessage);
		},
		json(message) {
			process.stdout.write(message);
		},
	};
}
