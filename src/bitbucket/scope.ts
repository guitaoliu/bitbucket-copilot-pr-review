import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import type { BitbucketTransport } from "./transport.ts";

export interface BitbucketRepoScope {
	transport: Pick<BitbucketTransport, "request" | "requestJson">;
	logger: Logger;
	pullRequestPath: string;
	insightsRepositoryPath: string;
}

export function createBitbucketRepoScope(
	config: Pick<ReviewerConfig["bitbucket"], "projectKey" | "repoSlug" | "prId">,
	transport: BitbucketRepoScope["transport"],
	logger: Logger,
): BitbucketRepoScope {
	const repositoryPath = `/projects/${encodeURIComponent(config.projectKey)}/repos/${encodeURIComponent(config.repoSlug)}`;
	return {
		transport,
		logger,
		pullRequestPath: `/rest/api/latest${repositoryPath}/pull-requests/${config.prId}`,
		insightsRepositoryPath: `/rest/insights/latest${repositoryPath}`,
	};
}
