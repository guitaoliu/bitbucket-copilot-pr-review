import type { CodeInsightsApi } from "../bitbucket/code-insights.ts";
import type { PullRequestCommentsApi } from "../bitbucket/comments.ts";
import type { PullRequestApi } from "../bitbucket/pull-request.ts";
import type {
	InsightReportPayload,
	PullRequestCommentDraft,
	PullRequestInfo,
} from "../bitbucket/types.ts";
import type { OperatorConfig, ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import type { PreparedReviewContext } from "./context.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";

export interface ReviewBitbucketClient {
	pullRequest: Pick<PullRequestApi, "getPullRequest">;
	codeInsights: Pick<CodeInsightsApi, "getReport" | "putReport">;
	comments: Pick<
		PullRequestCommentsApi,
		"listComments" | "reconcileKeyedComments" | "upsertComment"
	>;
}

export interface ReviewArtifacts {
	review: ReviewOutcome;
	report: InsightReportPayload;
	commentBody: string;
	findingComments: PullRequestCommentDraft[];
}

export interface ReviewRunnerDependencies {
	createBitbucketClient: (
		config: ReviewerConfig["bitbucket"],
		logger: Logger,
	) => ReviewBitbucketClient;
	prepareReviewContext: (
		operatorConfig: OperatorConfig,
		logger: Logger,
		pr: PullRequestInfo,
	) => Promise<PreparedReviewContext>;
	buildReviewContext: (
		prepared: PreparedReviewContext,
		logger: Logger,
		pr: PullRequestInfo,
	) => Promise<ReviewContext>;
	runCopilotReview: (
		config: ReviewerConfig,
		context: ReviewContext,
		git: GitRepository,
		logger: Logger,
	) => Promise<ReviewOutcome>;
	confirmRerun: (options: { message: string }) => Promise<boolean>;
}
