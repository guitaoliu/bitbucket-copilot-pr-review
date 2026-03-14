import { createHash } from "node:crypto";

import { z } from "zod";

import { omitUndefined } from "../shared/object.ts";
import type {
	Confidence,
	LogLevel,
	PullRequestCommentStrategy,
	ReasoningEffort,
	ReviewerConfigExplicitEnvOverrides,
} from "./types.ts";

const CONFIDENCE_VALUES = [
	"low",
	"medium",
	"high",
] as const satisfies readonly Confidence[];
const LOG_LEVEL_VALUES = [
	"debug",
	"info",
	"warn",
	"error",
] as const satisfies readonly LogLevel[];
const BITBUCKET_AUTH_TYPE_VALUES = ["basic", "bearer"] as const;
const REASONING_EFFORT_VALUES = [
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly ReasoningEffort[];
const REPORT_COMMENT_STRATEGY_VALUES = [
	"update",
	"recreate",
] as const satisfies readonly PullRequestCommentStrategy[];
const MAX_REPORT_KEY_LENGTH = 50;
const REPORT_KEY_SAFE_CHAR_PATTERN = /[^A-Za-z0-9._-]+/g;

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function normalizeOptionalEnvString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function optionalEnvString() {
	return z.preprocess(normalizeOptionalEnvString, z.string().optional());
}

function optionalStringArray(name: string) {
	return optionalEnvString().transform((value, ctx): string[] | undefined => {
		if (value === undefined) {
			return undefined;
		}

		const parts = value
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (parts.length === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${name} must contain at least one non-empty value when provided.`,
			});
			return z.NEVER;
		}

		return parts;
	});
}

function requiredEnvString(name: string) {
	return optionalEnvString().transform((value, ctx): string => {
		if (value !== undefined) {
			return value;
		}

		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `${name} is required.`,
		});
		return z.NEVER;
	});
}

function optionalEnumValue<TValues extends readonly [string, ...string[]]>(
	name: string,
	values: TValues,
) {
	return optionalEnvString().transform(
		(value, ctx): TValues[number] | undefined => {
			if (value === undefined) {
				return undefined;
			}

			if ((values as readonly string[]).includes(value)) {
				return value as TValues[number];
			}

			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${name} must be one of: ${values.join(", ")}.`,
			});
			return z.NEVER;
		},
	);
}

function toPositiveInteger(
	name: string,
	value: string,
	ctx: z.RefinementCtx,
): number {
	if (!/^\d+$/.test(value)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `${name} must be a positive integer.`,
		});
		return z.NEVER;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `${name} must be a positive integer.`,
		});
		return z.NEVER;
	}

	return parsed;
}

function requiredPositiveInteger(name: string) {
	return requiredEnvString(name).transform((value, ctx) =>
		toPositiveInteger(name, value, ctx),
	);
}

function optionalPositiveInteger(name: string, fallback: number) {
	return optionalEnvString().transform((value, ctx) => {
		if (value === undefined) {
			return fallback;
		}

		return toPositiveInteger(name, value, ctx);
	});
}

export function normalizeReportKey(reportKey: string): string {
	const sanitized = reportKey
		.trim()
		.replace(REPORT_KEY_SAFE_CHAR_PATTERN, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");

	if (sanitized.length === 0) {
		return "copilot-pr-review";
	}

	if (sanitized.length <= MAX_REPORT_KEY_LENGTH) {
		return sanitized;
	}

	const digest = createHash("sha1")
		.update(sanitized)
		.digest("hex")
		.slice(0, 10);
	const suffix = `-${digest}`;
	const prefixLength = Math.max(1, MAX_REPORT_KEY_LENGTH - suffix.length);
	return `${sanitized.slice(0, prefixLength)}${suffix}`;
}

function optionalBoolean(name: string, fallback: boolean) {
	return optionalEnvString().transform((value, ctx) => {
		if (value === undefined) {
			return fallback;
		}

		const normalized = value.toLowerCase();
		if (["1", "true", "yes", "y", "on"].includes(normalized)) {
			return true;
		}

		if (["0", "false", "no", "n", "off"].includes(normalized)) {
			return false;
		}

		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `${name} must be a boolean value such as true/false or 1/0.`,
		});
		return z.NEVER;
	});
}

const envSchema = z
	.object({
		REPO_ROOT: optionalEnvString(),
		BITBUCKET_BASE_URL:
			requiredEnvString("BITBUCKET_BASE_URL").transform(normalizeBaseUrl),
		BITBUCKET_PROJECT_KEY: requiredEnvString("BITBUCKET_PROJECT_KEY"),
		BITBUCKET_REPO_SLUG: requiredEnvString("BITBUCKET_REPO_SLUG"),
		BITBUCKET_PR_ID: requiredPositiveInteger("BITBUCKET_PR_ID"),
		BITBUCKET_AUTH_TYPE: optionalEnumValue(
			"BITBUCKET_AUTH_TYPE",
			BITBUCKET_AUTH_TYPE_VALUES,
		),
		BITBUCKET_TOKEN: optionalEnvString(),
		BITBUCKET_USERNAME: optionalEnvString(),
		BITBUCKET_PASSWORD: optionalEnvString(),
		BITBUCKET_CA_CERT_PATH: optionalEnvString(),
		BITBUCKET_INSECURE_TLS: optionalBoolean("BITBUCKET_INSECURE_TLS", true),
		GIT_REMOTE_NAME: optionalEnvString().transform(
			(value) => value ?? "origin",
		),
		LOG_LEVEL: optionalEnumValue("LOG_LEVEL", LOG_LEVEL_VALUES).transform(
			(value): LogLevel => value ?? "info",
		),
		REVIEW_MIN_CONFIDENCE: optionalEnumValue(
			"REVIEW_MIN_CONFIDENCE",
			CONFIDENCE_VALUES,
		).transform((value): Confidence => value ?? "medium"),
		COPILOT_MODEL: optionalEnvString().transform((value) => value ?? "gpt-5.4"),
		COPILOT_REASONING_EFFORT: optionalEnumValue(
			"COPILOT_REASONING_EFFORT",
			REASONING_EFFORT_VALUES,
		).transform((value): ReasoningEffort => value ?? "xhigh"),
		COPILOT_TIMEOUT_MS: optionalPositiveInteger("COPILOT_TIMEOUT_MS", 1800000),
		REPORT_KEY: optionalEnvString().transform(
			(value) => value ?? "copilot-pr-review",
		),
		REPORT_TITLE: optionalEnvString().transform(
			(value) => value ?? "Copilot PR Review",
		),
		REPORTER_NAME: optionalEnvString().transform(
			(value) => value ?? "GitHub Copilot via Jenkins",
		),
		REPORT_COMMENT_TAG: optionalEnvString().transform(
			(value) => value ?? "copilot-pr-review",
		),
		REPORT_COMMENT_STRATEGY: optionalEnumValue(
			"REPORT_COMMENT_STRATEGY",
			REPORT_COMMENT_STRATEGY_VALUES,
		).transform((value): PullRequestCommentStrategy => value ?? "recreate"),
		REPORT_LINK: optionalEnvString(),
		BUILD_URL: optionalEnvString(),
		REVIEW_FORCE: optionalBoolean("REVIEW_FORCE", false),
		REVIEW_MAX_FILES: optionalPositiveInteger("REVIEW_MAX_FILES", 200),
		REVIEW_MAX_FINDINGS: optionalPositiveInteger("REVIEW_MAX_FINDINGS", 25),
		REVIEW_MAX_PATCH_CHARS: optionalPositiveInteger(
			"REVIEW_MAX_PATCH_CHARS",
			12000,
		),
		REVIEW_DEFAULT_FILE_SLICE_LINES: optionalPositiveInteger(
			"REVIEW_DEFAULT_FILE_SLICE_LINES",
			250,
		),
		REVIEW_MAX_FILE_SLICE_LINES: optionalPositiveInteger(
			"REVIEW_MAX_FILE_SLICE_LINES",
			400,
		),
		REVIEW_IGNORE_PATHS: optionalStringArray("REVIEW_IGNORE_PATHS"),
		CI_SUMMARY_PATH: optionalEnvString(),
		COPILOT_GITHUB_TOKEN: optionalEnvString(),
		GH_TOKEN: optionalEnvString(),
		GITHUB_TOKEN: optionalEnvString(),
	})
	.superRefine((env, ctx) => {
		const hasBearerToken = env.BITBUCKET_TOKEN !== undefined;
		const hasUsername = env.BITBUCKET_USERNAME !== undefined;
		const hasPassword = env.BITBUCKET_PASSWORD !== undefined;

		const addIssue = (message: string, path?: keyof typeof env): void => {
			ctx.addIssue(
				omitUndefined({
					code: z.ZodIssueCode.custom,
					message,
					path: path ? [path] : undefined,
				}),
			);
		};

		if (env.BITBUCKET_AUTH_TYPE === "basic") {
			if (!hasUsername) {
				addIssue(
					"BITBUCKET_USERNAME is required when BITBUCKET_AUTH_TYPE=basic.",
					"BITBUCKET_USERNAME",
				);
			}
			if (!hasPassword) {
				addIssue(
					"BITBUCKET_PASSWORD is required when BITBUCKET_AUTH_TYPE=basic.",
					"BITBUCKET_PASSWORD",
				);
			}
			return;
		}

		if (env.BITBUCKET_AUTH_TYPE === "bearer") {
			if (!hasBearerToken) {
				addIssue(
					"BITBUCKET_TOKEN is required when BITBUCKET_AUTH_TYPE=bearer.",
					"BITBUCKET_TOKEN",
				);
			}
			return;
		}

		if (hasBearerToken) {
			return;
		}

		if (hasUsername || hasPassword) {
			if (!hasUsername) {
				addIssue(
					"BITBUCKET_USERNAME is required when using basic Bitbucket authentication.",
					"BITBUCKET_USERNAME",
				);
			}
			if (!hasPassword) {
				addIssue(
					"BITBUCKET_PASSWORD is required when using basic Bitbucket authentication.",
					"BITBUCKET_PASSWORD",
				);
			}
			return;
		}

		addIssue(
			"Provide BITBUCKET_TOKEN or BITBUCKET_USERNAME and BITBUCKET_PASSWORD for Bitbucket authentication.",
		);
	});

export type ParsedEnvironment = z.output<typeof envSchema>;

export function getExplicitEnvOverrides(
	env: NodeJS.ProcessEnv,
): ReviewerConfigExplicitEnvOverrides {
	const hasValue = (name: string): boolean =>
		normalizeOptionalEnvString(env[name]) !== undefined;

	return {
		copilot: {
			model: hasValue("COPILOT_MODEL"),
			reasoningEffort: hasValue("COPILOT_REASONING_EFFORT"),
			timeoutMs: hasValue("COPILOT_TIMEOUT_MS"),
		},
		report: {
			title: hasValue("REPORT_TITLE"),
			commentStrategy: hasValue("REPORT_COMMENT_STRATEGY"),
		},
		review: {
			maxFiles: hasValue("REVIEW_MAX_FILES"),
			maxFindings: hasValue("REVIEW_MAX_FINDINGS"),
			minConfidence: hasValue("REVIEW_MIN_CONFIDENCE"),
			maxPatchChars: hasValue("REVIEW_MAX_PATCH_CHARS"),
			defaultFileSliceLines: hasValue("REVIEW_DEFAULT_FILE_SLICE_LINES"),
			maxFileSliceLines: hasValue("REVIEW_MAX_FILE_SLICE_LINES"),
			ignorePaths: hasValue("REVIEW_IGNORE_PATHS"),
		},
	};
}

function formatEnvironmentError(error: z.ZodError): string {
	return error.issues.map((issue) => issue.message).join("\n");
}

export function parseEnvironment(env: NodeJS.ProcessEnv): ParsedEnvironment {
	const result = envSchema.safeParse(env);
	if (result.success) {
		return result.data;
	}

	throw new Error(formatEnvironmentError(result.error));
}
