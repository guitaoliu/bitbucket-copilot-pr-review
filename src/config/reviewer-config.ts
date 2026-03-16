import { z } from "zod";

import {
	CONFIDENCE_VALUES,
	CONFIG_FIELD_METADATA,
	isRepoOverrideField,
	LOG_LEVEL_VALUES,
	REASONING_EFFORT_VALUES,
	REPORT_COMMENT_STRATEGY_VALUES,
} from "./metadata.ts";
import {
	getConfigPathValue,
	setConfigPathValue,
	splitConfigPath,
} from "./path.ts";
import type { ReviewerConfig, ReviewerConfigRepoOverrides } from "./types.ts";

type RepoOverrideGroup = keyof ReviewerConfigRepoOverrides;
type RepoOverridePath = readonly [RepoOverrideGroup, ...string[]];

function isRepoOverrideGroup(value: string): value is RepoOverrideGroup {
	return value === "copilot" || value === "report" || value === "review";
}

function toRepoOverridePath(path: string): RepoOverridePath {
	const [group, ...nestedPath] = splitConfigPath(path);
	if (
		group === undefined ||
		!isRepoOverrideGroup(group) ||
		nestedPath.length === 0
	) {
		throw new Error(
			`Repo override metadata path ${path} must target copilot, report, or review fields.`,
		);
	}

	return [group, ...nestedPath];
}

const REPO_OVERRIDE_PATHS = Object.values(CONFIG_FIELD_METADATA).flatMap(
	(field) =>
		isRepoOverrideField(field) ? [toRepoOverridePath(field.path)] : [],
);

function buildRepoOverrides(
	resolveValue: (path: RepoOverridePath) => unknown,
): ReviewerConfigRepoOverrides {
	const overrides = createEmptyRepoOverrides();

	for (const path of REPO_OVERRIDE_PATHS) {
		const value = resolveValue(path);
		if (value === undefined) {
			continue;
		}

		setConfigPathValue(overrides, path, value);
	}

	return validateReviewerConfigRepoOverrides(overrides);
}

export const reviewerConfigRepoOverridesSchema = z
	.object({
		copilot: z
			.object({
				model: z.string().min(1).optional(),
				reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
				timeoutMs: z.number().int().positive().optional(),
			})
			.strict(),
		report: z
			.object({
				title: z.string().min(1).optional(),
				commentStrategy: z.enum(REPORT_COMMENT_STRATEGY_VALUES).optional(),
			})
			.strict(),
		review: z
			.object({
				maxFiles: z.number().int().positive().optional(),
				maxFindings: z.number().int().positive().optional(),
				minConfidence: z.enum(CONFIDENCE_VALUES).optional(),
				maxPatchChars: z.number().int().positive().optional(),
				defaultFileSliceLines: z.number().int().positive().optional(),
				maxFileSliceLines: z.number().int().positive().optional(),
				ignorePaths: z.array(z.string().min(1)).optional(),
				skipBranchPrefixes: z.array(z.string().min(1)).optional(),
			})
			.strict(),
	})
	.strict();

export const reviewerConfigSchema = z
	.object({
		repoRoot: z.string().min(1),
		gitRemoteName: z.string().min(1),
		logLevel: z.enum(LOG_LEVEL_VALUES),
		bitbucket: z
			.object({
				baseUrl: z.string().min(1),
				projectKey: z.string().min(1),
				repoSlug: z.string().min(1),
				prId: z.number().int().positive(),
				auth: z.discriminatedUnion("type", [
					z
						.object({
							type: z.literal("bearer"),
							token: z.string().min(1),
						})
						.strict(),
					z
						.object({
							type: z.literal("basic"),
							username: z.string().min(1),
							password: z.string().min(1),
						})
						.strict(),
				]),
				tls: z
					.object({
						caCertPath: z.string().min(1).optional(),
						insecureSkipVerify: z.boolean(),
					})
					.strict(),
			})
			.strict(),
		copilot: z
			.object({
				model: z.string().min(1),
				githubToken: z.string().min(1).optional(),
				reasoningEffort: z.enum(REASONING_EFFORT_VALUES),
				timeoutMs: z.number().int().positive(),
			})
			.strict(),
		report: z
			.object({
				key: z.string().min(1),
				title: z.string().min(1),
				reporter: z.string().min(1),
				link: z.string().min(1).optional(),
				commentTag: z.string().min(1),
				commentStrategy: z.enum(REPORT_COMMENT_STRATEGY_VALUES),
			})
			.strict(),
		review: z
			.object({
				dryRun: z.boolean(),
				forceReview: z.boolean(),
				confirmRerun: z.boolean(),
				maxFiles: z.number().int().positive(),
				maxFindings: z.number().int().positive(),
				minConfidence: z.enum(CONFIDENCE_VALUES),
				maxPatchChars: z.number().int().positive(),
				defaultFileSliceLines: z.number().int().positive(),
				maxFileSliceLines: z.number().int().positive(),
				ignorePaths: z.array(z.string().min(1)),
				skipBranchPrefixes: z.array(z.string().min(1)),
			})
			.strict(),
		ciSummaryPath: z.string().min(1).optional(),
		internal: z
			.object({
				envRepoOverrides: reviewerConfigRepoOverridesSchema,
				trustedRepoConfig: z
					.object({
						path: z.string().min(1),
						commit: z.string().min(1),
					})
					.strict()
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((config, ctx) => {
		if (config.review.defaultFileSliceLines > config.review.maxFileSliceLines) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["review", "defaultFileSliceLines"],
				message:
					"review.defaultFileSliceLines must be less than or equal to review.maxFileSliceLines.",
			});
		}
	});

function formatReviewerConfigError(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const pathLabel = issue.path.length > 0 ? issue.path.join(".") : "config";
			return `${pathLabel}: ${issue.message}`;
		})
		.join("\n");
}

export function cloneRepoOverrides(
	overrides: ReviewerConfigRepoOverrides,
): ReviewerConfigRepoOverrides {
	return buildRepoOverrides((path) => getConfigPathValue(overrides, path));
}

export function createEmptyRepoOverrides(): ReviewerConfigRepoOverrides {
	return {
		copilot: {},
		report: {},
		review: {},
	};
}

export function validateReviewerConfigRepoOverrides(
	input: unknown,
): ReviewerConfigRepoOverrides {
	const result = reviewerConfigRepoOverridesSchema.safeParse(input);
	if (result.success) {
		return result.data as ReviewerConfigRepoOverrides;
	}

	throw new Error(formatReviewerConfigError(result.error));
}

export function pickRepoOverrides(
	source: unknown,
): ReviewerConfigRepoOverrides {
	return buildRepoOverrides((path) => getConfigPathValue(source, path));
}

export function mergeRepoOverrides(
	primary: ReviewerConfigRepoOverrides,
	fallback: ReviewerConfigRepoOverrides,
): ReviewerConfigRepoOverrides {
	return buildRepoOverrides((path) => {
		const primaryValue = getConfigPathValue(primary, path);
		if (primaryValue !== undefined) {
			return primaryValue;
		}

		return getConfigPathValue(fallback, path);
	});
}

function cloneReviewerConfigForRepoOverrides(
	config: ReviewerConfig,
): ReviewerConfig {
	return {
		...config,
		copilot: { ...config.copilot },
		report: { ...config.report },
		review: { ...config.review },
		...(config.internal
			? {
					internal: {
						...config.internal,
						envRepoOverrides: cloneRepoOverrides(
							config.internal.envRepoOverrides,
						),
					},
				}
			: {}),
	};
}

function applyResolvedRepoOverrides(
	config: ReviewerConfig,
	overrides: ReviewerConfigRepoOverrides,
): ReviewerConfig {
	const nextConfig = cloneReviewerConfigForRepoOverrides(config);

	for (const path of REPO_OVERRIDE_PATHS) {
		const value = getConfigPathValue(overrides, path);
		if (value === undefined) {
			continue;
		}

		setConfigPathValue(nextConfig, path, value);
	}

	return nextConfig;
}

export function validateReviewerConfig(input: unknown): ReviewerConfig {
	const result = reviewerConfigSchema.safeParse(input);
	if (result.success) {
		return result.data as ReviewerConfig;
	}

	throw new Error(formatReviewerConfigError(result.error));
}

export function applyRepoOverrides(
	config: ReviewerConfig,
	repoOverrides: ReviewerConfigRepoOverrides,
): ReviewerConfig {
	return validateReviewerConfig(
		applyResolvedRepoOverrides(
			config,
			mergeRepoOverrides(repoOverrides, pickRepoOverrides(config)),
		),
	);
}
