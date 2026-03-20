import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import type { ReviewArtifacts, ReviewBitbucketClient } from "./runner-types.ts";
import type {
	ReviewContext,
	ReviewOutcome,
	ReviewPublication,
	ReviewPublicationError,
} from "./types.ts";

export interface PublishResult {
	published: boolean;
	publication: ReviewPublication;
	review: ReviewOutcome;
}

function createPublicationError(
	stage: ReviewPublicationError["stage"],
	error: unknown,
): ReviewPublicationError {
	return {
		stage,
		message: error instanceof Error ? error.message : String(error),
	};
}

async function upsertPullRequestCommentWithRetry(
	bitbucket: ReviewBitbucketClient,
	config: ReviewerConfig,
	artifacts: ReviewArtifacts,
	logger: Logger,
): Promise<void> {
	try {
		await bitbucket.upsertPullRequestComment(
			config.report.commentTag,
			artifacts.commentBody,
			{ strategy: config.report.commentStrategy },
		);
	} catch (firstError) {
		logger.warn(
			"Pull request comment update failed once; retrying before marking publication partial.",
			firstError,
		);
		await bitbucket.upsertPullRequestComment(
			config.report.commentTag,
			artifacts.commentBody,
			{ strategy: config.report.commentStrategy },
		);
	}
}

export async function publishReview(
	bitbucket: ReviewBitbucketClient,
	config: ReviewerConfig,
	context: ReviewContext,
	review: ReviewOutcome,
	artifacts: ReviewArtifacts,
	logger: Logger,
): Promise<PublishResult> {
	if (config.review.dryRun) {
		logger.info("Dry run enabled, skipping Bitbucket Code Insights publish.");
		return {
			published: false,
			publication: {
				status: "dry_run",
				attempted: false,
				codeInsightsPublished: false,
				pullRequestCommentUpdated: false,
			},
			review,
		};
	}

	const latestPullRequest = await bitbucket.getPullRequest();
	if (latestPullRequest.source.latestCommit !== context.headCommit) {
		logger.warn(
			`Skipping publish because the PR head moved from ${context.headCommit} to ${latestPullRequest.source.latestCommit}`,
		);
		return {
			published: false,
			publication: {
				status: "stale",
				attempted: false,
				codeInsightsPublished: false,
				pullRequestCommentUpdated: false,
			},
			review: {
				...review,
				stale: true,
			},
		};
	}

	try {
		await bitbucket.publishCodeInsights(
			context.headCommit,
			config.report.key,
			artifacts.report,
			artifacts.annotations,
		);
	} catch (error) {
		const publicationError = createPublicationError("code_insights", error);
		logger.error(
			`Bitbucket publication failed before the PR comment update at stage ${publicationError.stage}: ${publicationError.message}`,
			error,
		);
		return {
			published: false,
			publication: {
				status: "failed",
				attempted: true,
				codeInsightsPublished: false,
				pullRequestCommentUpdated: false,
				error: publicationError,
			},
			review,
		};
	}

	try {
		await upsertPullRequestCommentWithRetry(
			bitbucket,
			config,
			artifacts,
			logger,
		);
	} catch (error) {
		const publicationError = createPublicationError(
			"pull_request_comment",
			error,
		);
		logger.error(
			`Bitbucket publication completed the report publish but failed during PR comment update: ${publicationError.message}`,
			error,
		);
		return {
			published: false,
			publication: {
				status: "partial",
				attempted: true,
				codeInsightsPublished: true,
				pullRequestCommentUpdated: false,
				error: publicationError,
			},
			review,
		};
	}

	return {
		published: true,
		publication: {
			status: "published",
			attempted: true,
			codeInsightsPublished: true,
			pullRequestCommentUpdated: true,
		},
		review,
	};
}
