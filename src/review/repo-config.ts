import { resolveReviewerConfig } from "../config/load.ts";
import { parseRepoReviewConfig } from "../config/repo-config.ts";
import type { OperatorConfig, ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";

const TRUSTED_REPO_CONFIG_PATH = "copilot-code-review.json";

export async function loadTrustedRepoConfig(
	operatorConfig: OperatorConfig,
	git: GitRepository,
	baseCommit: string,
	logger: Logger,
): Promise<ReviewerConfig> {
	const location = `${baseCommit}:${TRUSTED_REPO_CONFIG_PATH}`;
	let repoConfigText: string | undefined;
	try {
		const result = await git.readTextFileAtCommit(
			baseCommit,
			TRUSTED_REPO_CONFIG_PATH,
		);
		repoConfigText = result.status === "ok" ? result.content : undefined;
	} catch (error) {
		logger.warn(`Unable to read trusted repo config from ${location}`, error);
		return resolveReviewerConfig(operatorConfig);
	}

	if (repoConfigText === undefined) {
		logger.debug(`No trusted repo config found at ${location}`);
		return resolveReviewerConfig(operatorConfig);
	}

	const repoConfig = parseRepoReviewConfig(repoConfigText, location);
	logger.info(`Loaded trusted repo config from ${location}`);
	return resolveReviewerConfig(operatorConfig, repoConfig);
}
