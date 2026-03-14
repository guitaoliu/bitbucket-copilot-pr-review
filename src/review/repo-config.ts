import {
	mergeRepoReviewConfig,
	parseRepoReviewConfig,
} from "../config/repo-config.ts";
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
		repoConfigText = await git.readFileAtCommit(
			baseCommit,
			TRUSTED_REPO_CONFIG_PATH,
		);
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
	merged.internal = {
		explicitEnvOverrides: config.internal?.explicitEnvOverrides ?? {
			copilot: { model: false, reasoningEffort: false, timeoutMs: false },
			report: { title: false, commentStrategy: false },
			review: {
				maxFiles: false,
				maxFindings: false,
				minConfidence: false,
				maxPatchChars: false,
				defaultFileSliceLines: false,
				maxFileSliceLines: false,
				ignorePaths: false,
			},
		},
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
