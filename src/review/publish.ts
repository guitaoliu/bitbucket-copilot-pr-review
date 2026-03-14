import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import type { ReviewArtifacts, ReviewBitbucketClient } from "./runner-types.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";

export interface PublishResult {
	published: boolean;
	review: ReviewOutcome;
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
		return { published: false, review };
	}

	const latestPullRequest = await bitbucket.getPullRequest();
	if (latestPullRequest.source.latestCommit !== context.headCommit) {
		logger.warn(
			`Skipping publish because the PR head moved from ${context.headCommit} to ${latestPullRequest.source.latestCommit}`,
		);
		return {
			published: false,
			review: {
				...review,
				stale: true,
			},
		};
	}

	await bitbucket.publishCodeInsights(
		context.headCommit,
		config.report.key,
		artifacts.report,
		artifacts.annotations,
	);
	await bitbucket.upsertPullRequestComment(
		config.report.commentTag,
		artifacts.commentBody,
		{ strategy: config.report.commentStrategy },
	);

	return { published: true, review };
}
