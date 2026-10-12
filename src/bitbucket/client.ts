import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import { CodeInsightsApi } from "./code-insights.ts";
import { PullRequestCommentsApi } from "./comments.ts";
import { PullRequestApi } from "./pull-request.ts";
import { createBitbucketRepoScope } from "./scope.ts";
import { BitbucketTransport } from "./transport.ts";

export interface BitbucketClient {
	pullRequest: PullRequestApi;
	codeInsights: CodeInsightsApi;
	comments: PullRequestCommentsApi;
}

export function createBitbucketClient(
	config: ReviewerConfig["bitbucket"],
	logger: Logger,
): BitbucketClient {
	const scope = createBitbucketRepoScope(
		config,
		new BitbucketTransport(config),
		logger,
	);
	return {
		pullRequest: new PullRequestApi(scope),
		codeInsights: new CodeInsightsApi(scope),
		comments: new PullRequestCommentsApi(scope),
	};
}
