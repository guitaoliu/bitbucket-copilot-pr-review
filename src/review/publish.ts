import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import {
	applyCommentActions,
	type OwnTaggedComments,
	planFindingCommentSync,
	planSummaryCommentSync,
	selectOwnTaggedComments,
} from "./comment-sync.ts";
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

async function listOwnTaggedComments(
	bitbucket: ReviewBitbucketClient,
	tag: string,
	logger: Logger,
): Promise<OwnTaggedComments> {
	const botName = await bitbucket.getAuthenticatedUserName();
	const own = selectOwnTaggedComments(
		tag,
		botName,
		await bitbucket.comments.listComments(),
	);
	if (own.foreignCount > 0) {
		logger.debug(
			`Ignoring ${own.foreignCount} pull request comments that carry ${tag} markers but were not written by ${botName}.`,
		);
	}
	return own;
}

async function publishSummaryComment(
	bitbucket: ReviewBitbucketClient,
	config: ReviewerConfig,
	commentBody: string,
	own: OwnTaggedComments,
	logger: Logger,
): Promise<void> {
	const syncSummary = (current: OwnTaggedComments) =>
		applyCommentActions(
			bitbucket.comments,
			planSummaryCommentSync({
				own: current,
				body: commentBody,
				strategy: config.report.commentStrategy,
			}),
			{ label: "pull request summary comment", logger },
		);
	try {
		await syncSummary(own);
	} catch (firstError) {
		logger.warn(
			"Pull request comment update failed once; re-reading comments and retrying before marking publication partial.",
			firstError,
		);
		await syncSummary(
			await listOwnTaggedComments(bitbucket, config.report.commentTag, logger),
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
	let own: OwnTaggedComments | undefined;
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
				own = await listOwnTaggedComments(bitbucket, tag, logger);
				await applyCommentActions(
					bitbucket.comments,
					planFindingCommentSync({
						tag,
						own,
						drafts: artifacts.findingComments,
						currentCodeKeys: artifacts.currentCodeKeys,
						headCommit: context.headCommit,
					}),
					{ label: "pull request finding comment", logger },
				);
			},
		],
		[
			"pull_request_comment",
			async () =>
				publishSummaryComment(
					bitbucket,
					config,
					artifacts.commentBody,
					own ?? (await listOwnTaggedComments(bitbucket, tag, logger)),
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
