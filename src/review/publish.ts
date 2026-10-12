import type { PullRequestComment } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import { findSummaryComments, parseFindingCommentKey } from "./markers.ts";
import { FINDING_COMMENT_RETIREMENT } from "./render/finding-comment.ts";
import { SUMMARY_COMMENT_RETIREMENT } from "./render/summary-comment.ts";
import type { ReviewArtifacts, ReviewBitbucketClient } from "./runner-types.ts";
import type {
	PublicationResult,
	PublicationStage,
	ReviewContext,
} from "./types.ts";

function getStalePublishReason(
	context: ReviewContext,
	latestPullRequest: ReviewContext["pr"],
): string | undefined {
	if (latestPullRequest.state && latestPullRequest.state !== "OPEN") {
		return `Skipping publish because pull request #${latestPullRequest.id} is ${latestPullRequest.state}.`;
	}

	if (latestPullRequest.source.latestCommit !== context.headCommit) {
		return `Skipping publish because the PR head moved from ${context.headCommit} to ${latestPullRequest.source.latestCommit}`;
	}

	if (latestPullRequest.target.latestCommit !== context.baseCommit) {
		return `Skipping publish because the PR base moved from ${context.baseCommit} to ${latestPullRequest.target.latestCommit}`;
	}

	return undefined;
}

async function publishSummaryComment(
	bitbucket: ReviewBitbucketClient,
	config: ReviewerConfig,
	commentBody: string,
	comments: PullRequestComment[],
	logger: Logger,
): Promise<void> {
	const tag = config.report.commentTag;
	const options = {
		strategy: config.report.commentStrategy,
		retirement: SUMMARY_COMMENT_RETIREMENT,
	};
	try {
		await bitbucket.comments.upsertComment(
			findSummaryComments(tag, comments),
			commentBody,
			options,
		);
	} catch (firstError) {
		logger.warn(
			"Pull request comment update failed once; re-reading comments and retrying before marking publication partial.",
			firstError,
		);
		await bitbucket.comments.upsertComment(
			findSummaryComments(tag, await bitbucket.comments.listComments()),
			commentBody,
			options,
		);
	}
}

export async function publishReview(
	bitbucket: ReviewBitbucketClient,
	config: ReviewerConfig,
	context: ReviewContext,
	artifacts: ReviewArtifacts,
	logger: Logger,
): Promise<PublicationResult> {
	const { review } = artifacts;
	if (review.incomplete) {
		logger.warn(
			`Skipping Bitbucket publication because the review is incomplete: ${review.incomplete.reason}`,
		);
		return {
			status: "failed",
			completedStages: [],
			error: { stage: "review", message: review.incomplete.reason },
		};
	}

	if (config.review.dryRun) {
		logger.info("Dry run enabled, skipping Bitbucket Code Insights publish.");
		return { status: "dry_run", completedStages: [] };
	}

	const staleReason = getStalePublishReason(
		context,
		await bitbucket.pullRequest.getPullRequest(),
	);
	if (staleReason) {
		logger.warn(staleReason);
		return { status: "stale", completedStages: [] };
	}

	const tag = config.report.commentTag;
	let comments: PullRequestComment[] = [];
	const stages: Array<[PublicationStage, () => Promise<void>]> = [
		[
			"code_insights",
			() =>
				bitbucket.codeInsights.putReport(
					context.headCommit,
					config.report.key,
					artifacts.report,
				),
		],
		[
			"finding_comments",
			async () => {
				comments = await bitbucket.comments.listComments();
				await bitbucket.comments.reconcileKeyedComments(
					comments,
					artifacts.findingComments,
					{
						keyOf: (text) => parseFindingCommentKey(tag, text),
						retirement: FINDING_COMMENT_RETIREMENT,
					},
				);
			},
		],
		[
			"pull_request_comment",
			() =>
				publishSummaryComment(
					bitbucket,
					config,
					artifacts.commentBody,
					comments,
					logger,
				),
		],
	];
	const completedStages: PublicationStage[] = [];
	for (const [stage, publish] of stages) {
		try {
			await publish();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(
				`Bitbucket publication failed at stage ${stage} after completing [${completedStages.join(", ")}]: ${message}`,
				error,
			);
			return {
				status: completedStages.length === 0 ? "failed" : "partial",
				completedStages,
				error: { stage, message },
			};
		}
		completedStages.push(stage);
	}

	return { status: "published", completedStages };
}
