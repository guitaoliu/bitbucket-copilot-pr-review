import { z } from "zod";

import {
	CONFIDENCE_VALUES,
	REASONING_EFFORT_VALUES,
	REPORT_COMMENT_STRATEGY_VALUES,
} from "./metadata.ts";

export const REPO_CONFIG_LIMITS = {
	schemaRefMaxLength: 2048,
	modelMaxLength: 120,
	reportTitleMaxLength: 120,
	timeoutMs: { min: 60_000, max: 7_200_000 },
	ignorePaths: { maxItems: 200, maxPatternLength: 512 },
	skipBranchPrefixes: { maxItems: 50, maxPrefixLength: 128 },
} as const;

function boundedInteger(name: string, limits: { min: number; max: number }) {
	return z
		.int(`${name} must be an integer.`)
		.min(limits.min, `${name} must be at least ${limits.min}.`)
		.max(limits.max, `${name} must be at most ${limits.max}.`);
}

function boundedStringArray(options: {
	fieldName: string;
	maxItems: number;
	maxEntryLength: number;
	requireNonEmptyArray?: boolean;
	entryLabel: string;
	entriesLabel: string;
}) {
	let schema = z.array(
		z
			.string()
			.min(1, `${options.fieldName} entries must not be empty.`)
			.max(
				options.maxEntryLength,
				`${options.fieldName} entries must be at most ${options.maxEntryLength} characters.`,
			),
	);

	if (options.requireNonEmptyArray) {
		schema = schema.min(
			1,
			`${options.fieldName} must contain at least one ${options.entryLabel}.`,
		);
	}

	return schema.max(
		options.maxItems,
		`${options.fieldName} must contain at most ${options.maxItems} ${options.entriesLabel}.`,
	);
}

export function createCopilotOverrideSchema() {
	return z
		.object({
			model: z
				.string()
				.min(1, "copilot.model must not be empty.")
				.max(
					REPO_CONFIG_LIMITS.modelMaxLength,
					`copilot.model must be at most ${REPO_CONFIG_LIMITS.modelMaxLength} characters.`,
				)
				.describe("Optional Copilot model override for this repository.")
				.optional(),
			reasoningEffort: z
				.enum(REASONING_EFFORT_VALUES)
				.describe("Optional reasoning effort override for this repository.")
				.optional(),
			timeoutMs: boundedInteger(
				"copilot.timeoutMs",
				REPO_CONFIG_LIMITS.timeoutMs,
			)
				.describe("Optional Copilot timeout in milliseconds.")
				.optional(),
		})
		.strict();
}

export function createReportOverrideSchema() {
	return z
		.object({
			title: z
				.string()
				.min(1, "report.title must not be empty.")
				.max(
					REPO_CONFIG_LIMITS.reportTitleMaxLength,
					`report.title must be at most ${REPO_CONFIG_LIMITS.reportTitleMaxLength} characters.`,
				)
				.describe("Optional Code Insights report title override.")
				.optional(),
			commentStrategy: z
				.enum(REPORT_COMMENT_STRATEGY_VALUES)
				.describe(
					"How the tagged pull request summary comment should be updated.",
				)
				.optional(),
		})
		.strict();
}

export function createReviewOverrideSchema(options?: {
	requireNonEmptyArrays?: boolean;
}) {
	return z
		.object({
			maxFiles: z
				.int("review.maxFiles must be an integer.")
				.positive("review.maxFiles must be positive.")
				.describe("Deprecated compatibility field; accepted but ignored.")
				.meta({ deprecated: true })
				.optional(),
			minConfidence: z
				.enum(CONFIDENCE_VALUES)
				.describe("Minimum confidence threshold for reportable findings.")
				.optional(),
			ignorePaths: boundedStringArray({
				fieldName: "review.ignorePaths",
				maxItems: REPO_CONFIG_LIMITS.ignorePaths.maxItems,
				maxEntryLength: REPO_CONFIG_LIMITS.ignorePaths.maxPatternLength,
				...(options?.requireNonEmptyArrays !== undefined
					? { requireNonEmptyArray: options.requireNonEmptyArrays }
					: {}),
				entryLabel: "pattern",
				entriesLabel: "patterns",
			})
				.describe(
					"Repo-relative glob patterns excluded from reportable finding scope.",
				)
				.optional(),
			skipBranchPrefixes: boundedStringArray({
				fieldName: "review.skipBranchPrefixes",
				maxItems: REPO_CONFIG_LIMITS.skipBranchPrefixes.maxItems,
				maxEntryLength: REPO_CONFIG_LIMITS.skipBranchPrefixes.maxPrefixLength,
				...(options?.requireNonEmptyArrays !== undefined
					? { requireNonEmptyArray: options.requireNonEmptyArrays }
					: {}),
				entryLabel: "prefix",
				entriesLabel: "prefixes",
			})
				.describe(
					"Source branch prefixes that should always be skipped during review.",
				)
				.optional(),
		})
		.strict();
}
