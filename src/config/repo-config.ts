import { z } from "zod";
import { CliUserError } from "./errors.ts";
import {
	createCopilotOverrideSchema,
	createReportOverrideSchema,
	createReviewOverrideSchema,
	REPO_CONFIG_LIMITS,
} from "./repo-override-schema.ts";
import {
	applyRepoOverrides,
	createEmptyRepoOverrides,
	mergeRepoOverrides,
	pickRepoOverrides,
} from "./reviewer-config.ts";
import type { ReviewerConfig, ReviewerConfigRepoOverrides } from "./types.ts";

const reviewRepoConfigSchema = createReviewOverrideSchema();

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
		copilot: createCopilotOverrideSchema().optional(),
		report: createReportOverrideSchema().optional(),
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
		throw new CliUserError(
			`Invalid JSON in ${pathLabel}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const result = repoConfigSchema.safeParse(parsed);
	if (result.success) {
		return result.data;
	}

	throw new CliUserError(
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
