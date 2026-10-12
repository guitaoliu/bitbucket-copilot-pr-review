import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import { CodeInsightsApi } from "./code-insights.ts";
import { PullRequestCommentsApi } from "./comments.ts";
import { PullRequestApi } from "./pull-request.ts";
import { createBitbucketRepoScope } from "./scope.ts";
import { BitbucketTransport } from "./transport.ts";

export interface BitbucketClient {
	getAuthenticatedUserName(): Promise<string>;
	pullRequest: PullRequestApi;
	codeInsights: CodeInsightsApi;
	comments: PullRequestCommentsApi;
}

export function createBitbucketClient(
	config: ReviewerConfig["bitbucket"],
	logger: Logger,
): BitbucketClient {
	const transport = new BitbucketTransport(config);
	const scope = createBitbucketRepoScope(config, transport, logger);
	return {
		getAuthenticatedUserName: () => transport.getAuthenticatedUserName(),
		pullRequest: new PullRequestApi(scope),
		codeInsights: new CodeInsightsApi(scope),
		comments: new PullRequestCommentsApi(scope),
	};
}
