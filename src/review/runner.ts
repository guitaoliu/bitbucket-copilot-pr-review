import { BitbucketClient } from "../bitbucket/client.ts";
import type { ReviewerConfig } from "../config/types.ts";
import { runCopilotReview } from "../copilot/engine.ts";
import type { Logger } from "../shared/logger.ts";
import { confirmRerun } from "./confirm.ts";
import { buildReviewContext } from "./context.ts";
import type { ReviewRunOutput } from "./output-types.ts";
import { publishReview } from "./publish.ts";
import {
	buildReviewArtifacts,
	buildReviewRunOutput,
	buildSkippedReviewOutput,
} from "./result.ts";
import type { ReviewRunnerDependencies } from "./runner-types.ts";
import {
	buildReviewReusePlan,
	getExistingPublicationStatus,
} from "./skip-policy.ts";

export async function runReview(
	config: ReviewerConfig,
	logger: Logger,
	dependencies: ReviewRunnerDependencies = {},
): Promise<ReviewRunOutput> {
	const bitbucket =
		dependencies.createBitbucketClient?.(config.bitbucket, logger) ??
		new BitbucketClient(config.bitbucket, logger);
	const buildContext = dependencies.buildReviewContext ?? buildReviewContext;
	const reviewWithCopilot = dependencies.runCopilotReview ?? runCopilotReview;
	const confirmRerunPrompt = dependencies.confirmRerun ?? confirmRerun;
	const initialPullRequest = await bitbucket.getPullRequest();

	logger.info(
		`Loaded pull request #${initialPullRequest.id} (${initialPullRequest.source.displayId} -> ${initialPullRequest.target.displayId})`,
	);

	if (initialPullRequest.state && initialPullRequest.state !== "OPEN") {
		const skipReason = `Skipping review because pull request #${initialPullRequest.id} is ${initialPullRequest.state}.`;
		logger.info(skipReason);
		return buildSkippedReviewOutput(config, initialPullRequest, skipReason);
	}

	const {
		config: effectiveConfig,
		context,
		git,
	} = await buildContext(config, logger, initialPullRequest);
	logger.info(
		`Review scope after file filtering: ${context.reviewedFiles.length} reviewed, ${context.skippedFiles.length} skipped out of ${context.diffStats.fileCount} changed files (REVIEW_MAX_FILES=${effectiveConfig.review.maxFiles}).`,
	);
	const publicationStatus = await getExistingPublicationStatus(
		bitbucket,
		effectiveConfig,
		context,
	);
	const reusePlan = buildReviewReusePlan(
		effectiveConfig,
		context,
		publicationStatus,
	);

	if (reusePlan.action === "skip" && reusePlan.reason) {
		logger.info(reusePlan.reason);
		return buildSkippedReviewOutput(
			effectiveConfig,
			initialPullRequest,
			reusePlan.reason,
			context.reviewRevision,
			context.mergeBaseCommit,
		);
	}

	if (
		config.review.confirmRerun &&
		reusePlan.action === "review" &&
		reusePlan.confirmMessage
	) {
		if (reusePlan.repairWarning) {
			logger.warn(reusePlan.repairWarning);
		}

		const confirmed = await confirmRerunPrompt({
			message: reusePlan.confirmMessage,
		});

		if (!confirmed) {
			const skipReason = `Skipped rerun for unchanged PR revision ${context.reviewRevision} after manual confirmation declined.`;
			logger.info(skipReason);
			return buildSkippedReviewOutput(
				effectiveConfig,
				initialPullRequest,
				skipReason,
				context.reviewRevision,
				context.mergeBaseCommit,
			);
		}
	}

	if (
		reusePlan.repairWarning &&
		!(
			config.review.confirmRerun &&
			reusePlan.action === "review" &&
			reusePlan.confirmMessage
		)
	) {
		logger.warn(reusePlan.repairWarning);
	}

	const review =
		reusePlan.action === "republish" && reusePlan.reusedReview
			? reusePlan.reusedReview
			: await reviewWithCopilot(effectiveConfig, context, git, logger);
	const artifacts =
		reusePlan.action === "republish" && reusePlan.reusedArtifacts
			? reusePlan.reusedArtifacts
			: buildReviewArtifacts(effectiveConfig, context, review);
	const publishResult = await publishReview(
		bitbucket,
		effectiveConfig,
		context,
		review,
		artifacts,
		logger,
	);

	return buildReviewRunOutput(
		context,
		publishResult.review,
		artifacts,
		publishResult.published,
	);
}
