import type { BatchReviewConfig } from "../batch/types.ts";
import { REVIEWER_CONFIG_DEFAULTS } from "../config/defaults.ts";
import {
	mergeRepoReviewConfig,
	parseRepoReviewConfig,
} from "../config/repo-config.ts";
import {
	cloneRepoOverrides,
	createEmptyRepoOverrides,
} from "../config/reviewer-config.ts";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";

const TRUSTED_REPO_CONFIG_PATH = "copilot-code-review.json";

export async function loadTrustedRepoConfig(
	config: ReviewerConfig,
	git: GitRepository,
	baseCommit: string,
	logger: Logger,
): Promise<ReviewerConfig> {
	let repoConfigText: string | undefined;
	try {
		const repoConfigResult = await git.readTextFileAtCommit(
			baseCommit,
			TRUSTED_REPO_CONFIG_PATH,
		);
		repoConfigText =
			repoConfigResult.status === "ok" ? repoConfigResult.content : undefined;
	} catch (error) {
		logger.warn(
			`Unable to read trusted repo config from ${baseCommit}:${TRUSTED_REPO_CONFIG_PATH}`,
			error,
		);
		return config;
	}

	if (repoConfigText === undefined) {
		logger.debug(
			`No trusted repo config found at ${baseCommit}:${TRUSTED_REPO_CONFIG_PATH}`,
		);
		return config;
	}

	const parsed = parseRepoReviewConfig(
		repoConfigText,
		`${baseCommit}:${TRUSTED_REPO_CONFIG_PATH}`,
	);
	const merged = mergeRepoReviewConfig(config, parsed);
	const envRepoOverrides =
		config.internal?.envRepoOverrides ?? createEmptyRepoOverrides();
	merged.internal = {
		envRepoOverrides: cloneRepoOverrides(envRepoOverrides),
		trustedRepoConfig: {
			path: TRUSTED_REPO_CONFIG_PATH,
			commit: baseCommit,
		},
	};

	logger.info(
		`Loaded trusted repo config from ${baseCommit}:${TRUSTED_REPO_CONFIG_PATH}`,
	);
	return merged;
}

export async function loadTrustedBatchReviewConfig(
	config: BatchReviewConfig,
	git: GitRepository,
	baseCommit: string,
	logger: Logger,
): Promise<BatchReviewConfig> {
	let repoConfigText: string | undefined;
	try {
		const repoConfigResult = await git.readTextFileAtCommit(
			baseCommit,
			TRUSTED_REPO_CONFIG_PATH,
		);
		repoConfigText =
			repoConfigResult.status === "ok" ? repoConfigResult.content : undefined;
	} catch (error) {
		logger.warn(
			`Unable to read trusted repo config from ${baseCommit}:${TRUSTED_REPO_CONFIG_PATH}`,
			error,
		);
		return config;
	}

	if (repoConfigText === undefined) {
		logger.debug(
			`No trusted repo config found at ${baseCommit}:${TRUSTED_REPO_CONFIG_PATH}`,
		);
		return config;
	}

	const parsed = parseRepoReviewConfig(
		repoConfigText,
		`${baseCommit}:${TRUSTED_REPO_CONFIG_PATH}`,
	);
	const envRepoOverrides =
		config.internal?.envRepoOverrides ?? createEmptyRepoOverrides();
	const mergedRepoConfig = mergeRepoReviewConfig(
		{
			repoRoot: config.tempRoot,
			gitRemoteName: config.gitRemoteName,
			logLevel: config.logLevel,
			bitbucket: {
				...config.bitbucket,
				prId: 1,
			},
			copilot: {
				model: "gpt-5.4",
				reasoningEffort: "xhigh",
				timeoutMs: 1_800_000,
			},
			report: {
				key: "copilot-pr-review",
				title: "Copilot PR Review",
				reporter: "GitHub Copilot via Jenkins",
				commentTag: "copilot-pr-review",
				commentStrategy: "recreate",
			},
			review: {
				dryRun: config.review.dryRun,
				forceReview: config.review.forceReview,
				confirmRerun: config.review.confirmRerun,
				maxFiles: REVIEWER_CONFIG_DEFAULTS.review.maxFiles,
				maxFindings: REVIEWER_CONFIG_DEFAULTS.review.maxFindings,
				minConfidence: REVIEWER_CONFIG_DEFAULTS.review.minConfidence,
				maxPatchChars: REVIEWER_CONFIG_DEFAULTS.review.maxPatchChars,
				defaultFileSliceLines:
					REVIEWER_CONFIG_DEFAULTS.review.defaultFileSliceLines,
				maxFileSliceLines: REVIEWER_CONFIG_DEFAULTS.review.maxFileSliceLines,
				ignorePaths: [],
				skipBranchPrefixes: config.review.skipBranchPrefixes,
			},
			internal: {
				envRepoOverrides: envRepoOverrides,
			},
		},
		parsed,
	);

	logger.info(
		`Loaded trusted repo config from ${baseCommit}:${TRUSTED_REPO_CONFIG_PATH}`,
	);

	return {
		...config,
		review: {
			...config.review,
			skipBranchPrefixes: mergedRepoConfig.review.skipBranchPrefixes,
		},
	};
}
