import { z } from "zod";

import { CliUserError } from "./errors.ts";
import {
	CONFIDENCE_VALUES,
	REASONING_EFFORT_VALUES,
	REPORT_COMMENT_STRATEGY_VALUES,
} from "./types.ts";

const REPO_CONFIG_LIMITS = {
	schemaRefMaxLength: 2048,
	modelMaxLength: 120,
	reportTitleMaxLength: 120,
	timeoutMs: { min: 60_000, max: 7_200_000 },
	ignorePaths: { maxItems: 200, maxPatternLength: 512 },
	skipBranchPrefixes: { maxItems: 50, maxPrefixLength: 128 },
} as const;

function boundedStringArray(options: {
	fieldName: string;
	maxItems: number;
	maxEntryLength: number;
	entriesLabel: string;
}) {
	return z
		.array(
			z
				.string()
				.min(1, `${options.fieldName} entries must not be empty.`)
				.max(
					options.maxEntryLength,
					`${options.fieldName} entries must be at most ${options.maxEntryLength} characters.`,
				),
		)
		.max(
			options.maxItems,
			`${options.fieldName} must contain at most ${options.maxItems} ${options.entriesLabel}.`,
		);
}

const copilotRepoConfigSchema = z
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
		timeoutMs: z
			.int("copilot.timeoutMs must be an integer.")
			.min(
				REPO_CONFIG_LIMITS.timeoutMs.min,
				`copilot.timeoutMs must be at least ${REPO_CONFIG_LIMITS.timeoutMs.min}.`,
			)
			.max(
				REPO_CONFIG_LIMITS.timeoutMs.max,
				`copilot.timeoutMs must be at most ${REPO_CONFIG_LIMITS.timeoutMs.max}.`,
			)
			.describe("Optional Copilot timeout in milliseconds.")
			.optional(),
	})
	.strict();

const reportRepoConfigSchema = z
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

const reviewRepoConfigSchema = z
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
			entriesLabel: "prefixes",
		})
			.describe(
				"Source branch prefixes that should always be skipped during review.",
			)
			.optional(),
	})
	.strict();

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
		copilot: copilotRepoConfigSchema.optional(),
		report: reportRepoConfigSchema.optional(),
		review: reviewRepoConfigSchema.optional(),
	})
	.strict();

export type RepoReviewConfig = z.output<typeof repoConfigSchema>;

export function parseRepoReviewConfig(
	configText: string,
	pathLabel = "copilot-code-review.json",
): RepoReviewConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(configText);
	} catch (error) {
		throw new CliUserError(
			`Invalid JSON in ${pathLabel}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const result = repoConfigSchema.safeParse(parsed);
	if (result.success) {
		return result.data;
	}

	const issues = result.error.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "config";
		return `${path}: ${issue.message}`;
	});
	throw new CliUserError(`Invalid ${pathLabel}:\n${issues.join("\n")}`);
}

export function getRepoReviewConfigSchema(): object {
	return z.toJSONSchema(repoConfigSchema);
}
