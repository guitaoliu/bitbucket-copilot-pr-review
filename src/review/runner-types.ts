import type {
	InsightAnnotationPayload,
	InsightReportPayload,
	PullRequestInfo,
	RawBitbucketCodeInsightsReport,
} from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";

export interface ReviewBitbucketClient {
	getPullRequest(): Promise<PullRequestInfo>;
	getCodeInsightsReport(
		commitId: string,
		reportKey: string,
	): Promise<RawBitbucketCodeInsightsReport | undefined>;
	getCodeInsightsAnnotationCount(
		commitId: string,
		reportKey: string,
	): Promise<number>;
	listCodeInsightsAnnotations(
		commitId: string,
		reportKey: string,
	): Promise<InsightAnnotationPayload[]>;
	findPullRequestCommentByTag(
		tag: string,
	): Promise<{ text: string; version?: number; id?: number } | undefined>;
	publishCodeInsights(
		commitId: string,
		reportKey: string,
		report: InsightReportPayload,
		annotations: InsightAnnotationPayload[],
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
	annotations: InsightAnnotationPayload[];
	commentBody: string;
}

export interface ReviewRunnerDependencies {
	createBitbucketClient?: (
		config: ReviewerConfig["bitbucket"],
		logger: Logger,
	) => ReviewBitbucketClient;
	buildReviewContext?: (
		config: ReviewerConfig,
		logger: Logger,
		pr: PullRequestInfo,
	) => Promise<{
		config: ReviewerConfig;
		context: ReviewContext;
		git: GitRepository;
	}>;
	runCopilotReview?: (
		config: ReviewerConfig,
		context: ReviewContext,
		git: GitRepository,
		logger: Logger,
	) => Promise<ReviewOutcome>;
	confirmRerun?: (options: { message: string }) => Promise<boolean>;
}
