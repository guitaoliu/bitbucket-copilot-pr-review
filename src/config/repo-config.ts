import { z } from "zod";

import {
	CONFIDENCE_VALUES,
	REASONING_EFFORT_VALUES,
	REPORT_COMMENT_STRATEGY_VALUES,
} from "./metadata.ts";
import {
	applyRepoOverrides,
	createEmptyRepoOverrides,
	mergeRepoOverrides,
	pickRepoOverrides,
} from "./reviewer-config.ts";
import type { ReviewerConfig, ReviewerConfigRepoOverrides } from "./types.ts";

const REPO_CONFIG_LIMITS = {
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
} as const;

function boundedInteger(name: string, limits: { min: number; max: number }) {
	return z
		.int(`${name} must be an integer.`)
		.min(limits.min, `${name} must be at least ${limits.min}.`)
		.max(limits.max, `${name} must be at most ${limits.max}.`);
}

const reviewRepoConfigSchema = z
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
		ignorePaths: z
			.array(
				z
					.string()
					.min(1, "review.ignorePaths entries must not be empty.")
					.max(
						REPO_CONFIG_LIMITS.ignorePaths.maxPatternLength,
						`review.ignorePaths entries must be at most ${REPO_CONFIG_LIMITS.ignorePaths.maxPatternLength} characters.`,
					),
			)
			.min(1, "review.ignorePaths must contain at least one pattern.")
			.max(
				REPO_CONFIG_LIMITS.ignorePaths.maxItems,
				`review.ignorePaths must contain at most ${REPO_CONFIG_LIMITS.ignorePaths.maxItems} patterns.`,
			)
			.describe(
				"Repo-relative glob patterns for changed files that should be skipped during review.",
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

const repoConfigSchema = z
	.object({
		$schema: z
			.string()
			.max(
				REPO_CONFIG_LIMITS.schemaRefMaxLength,
				`$schema must be at most ${REPO_CONFIG_LIMITS.schemaRefMaxLength} characters.`,
			)
			.describe("Optional JSON Schema reference for editor support.")
			.optional(),
		copilot: z
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
			.strict()
			.optional(),
		report: z
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
			.strict()
			.optional(),
		review: reviewRepoConfigSchema.optional(),
	})
	.strict();

export type RepoReviewConfig = z.output<typeof repoConfigSchema>;

export function toReviewerConfigRepoOverrides(
	repoConfig: RepoReviewConfig,
): ReviewerConfigRepoOverrides {
	return pickRepoOverrides(repoConfig);
}

function formatRepoConfigError(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "config";
			return `${path}: ${issue.message}`;
		})
		.join("\n");
}

export function parseRepoReviewConfig(
	configText: string,
	pathLabel = "copilot-code-review.json",
): RepoReviewConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(configText);
	} catch (error) {
		throw new Error(
			`Invalid JSON in ${pathLabel}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const result = repoConfigSchema.safeParse(parsed);
	if (result.success) {
		return result.data;
	}

	throw new Error(
		`Invalid ${pathLabel}:\n${formatRepoConfigError(result.error)}`,
	);
}

export function mergeRepoReviewConfig(
	config: ReviewerConfig,
	repoConfig: RepoReviewConfig,
): ReviewerConfig {
	const envOverrides =
		config.internal?.envRepoOverrides ?? createEmptyRepoOverrides();
	const repoOverrides = toReviewerConfigRepoOverrides(repoConfig);

	return applyRepoOverrides(
		config,
		mergeRepoOverrides(envOverrides, repoOverrides),
	);
}

export function getRepoReviewConfigSchema(): object {
	return z.toJSONSchema(repoConfigSchema);
}
