import type {
	InsightReportPayload,
	PullRequestInfo,
	RawBitbucketCodeInsightsReport,
} from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import type { PreparedReviewContext } from "./context.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";
import type { DetachedReviewWorkspace } from "./workspace.ts";

export interface ReviewBitbucketClient {
	getPullRequest(): Promise<PullRequestInfo>;
	getCodeInsightsReport(
		commitId: string,
		reportKey: string,
	): Promise<RawBitbucketCodeInsightsReport | undefined>;
	findPullRequestCommentByTag(
		tag: string,
	): Promise<{ text: string; version?: number; id?: number } | undefined>;
	publishCodeInsights(
		commitId: string,
		reportKey: string,
		report: InsightReportPayload,
	): Promise<void>;
	reconcilePullRequestFindingComments(
		tag: string,
		findings: ReviewOutcome["findings"],
		metadata: { revision: string; reviewedCommit: string },
	): Promise<void>;
	upsertPullRequestComment(
		tag: string,
		text: string,
		options?: {
			strategy?: ReviewerConfig["report"]["commentStrategy"];
		},
	): Promise<void>;
}

export interface ReviewArtifacts {
	report: InsightReportPayload;
	commentBody: string;
}

export interface ReviewRunnerDependencies {
	createBitbucketClient?: (
		config: ReviewerConfig["bitbucket"],
		logger: Logger,
	) => ReviewBitbucketClient;
	prepareReviewContext?: (
		config: ReviewerConfig,
		logger: Logger,
		pr: PullRequestInfo,
	) => Promise<PreparedReviewContext>;
	buildReviewContext?: (
		prepared: PreparedReviewContext,
		logger: Logger,
		pr: PullRequestInfo,
	) => Promise<ReviewContext>;
	runCopilotReview?: (
		config: ReviewerConfig,
		context: ReviewContext,
		git: GitRepository,
		logger: Logger,
	) => Promise<ReviewOutcome>;
	createDetachedReviewWorkspace?: (options: {
		repoRoot: string;
		commit: string;
		logger: Logger;
	}) => Promise<DetachedReviewWorkspace>;
	confirmRerun?: (options: { message: string }) => Promise<boolean>;
}
