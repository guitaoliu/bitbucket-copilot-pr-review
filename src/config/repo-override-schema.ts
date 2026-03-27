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
	timeoutMs: { min: 60_000, max: 3_600_000 },
	maxFiles: { min: 1, max: 500 },
	maxFindings: { min: 1, max: 100 },
	maxPatchChars: { min: 500, max: 50_000 },
	defaultFileSliceLines: { min: 1, max: 500 },
	maxFileSliceLines: { min: 1, max: 1_000 },
	ignorePaths: { maxItems: 200, maxPatternLength: 512 },
	skipBranchPrefixes: { maxItems: 50, maxPrefixLength: 128 },
} as const;

export function boundedInteger(
	name: string,
	limits: { min: number; max: number },
) {
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
	requireAtLeastOne?: boolean;
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

	if (options.requireAtLeastOne || options.requireNonEmptyArray) {
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
			maxFiles: boundedInteger("review.maxFiles", REPO_CONFIG_LIMITS.maxFiles)
				.describe("Maximum number of changed files to review after filtering.")
				.optional(),
			maxFindings: boundedInteger(
				"review.maxFindings",
				REPO_CONFIG_LIMITS.maxFindings,
			)
				.describe("Maximum number of findings to publish.")
				.optional(),
			minConfidence: z
				.enum(CONFIDENCE_VALUES)
				.describe("Minimum confidence threshold for reportable findings.")
				.optional(),
			maxPatchChars: boundedInteger(
				"review.maxPatchChars",
				REPO_CONFIG_LIMITS.maxPatchChars,
			)
				.describe("Maximum diff characters to send for a reviewed file.")
				.optional(),
			defaultFileSliceLines: boundedInteger(
				"review.defaultFileSliceLines",
				REPO_CONFIG_LIMITS.defaultFileSliceLines,
			)
				.describe("Default line window when reading file content slices.")
				.optional(),
			maxFileSliceLines: boundedInteger(
				"review.maxFileSliceLines",
				REPO_CONFIG_LIMITS.maxFileSliceLines,
			)
				.describe("Maximum line window allowed for file content slices.")
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
					"Repo-relative glob patterns for changed files that should be skipped during review.",
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
		.strict()
		.superRefine((review, ctx) => {
			if (
				review.defaultFileSliceLines !== undefined &&
				review.maxFileSliceLines !== undefined &&
				review.defaultFileSliceLines > review.maxFileSliceLines
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["defaultFileSliceLines"],
					message:
						"review.defaultFileSliceLines must be less than or equal to review.maxFileSliceLines.",
				});
			}
		});
}
