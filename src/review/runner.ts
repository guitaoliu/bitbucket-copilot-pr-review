import { BitbucketClient } from "../bitbucket/client.ts";
import type { ReviewerConfig } from "../config/types.ts";
import { runCopilotReview } from "../copilot/engine.ts";
import { GitRepository } from "../git/repo.ts";
import {
	getPullRequestBranchSkipReason,
	getPullRequestDraftSkipReason,
} from "../policy/pull-requests.ts";
import type { Logger } from "../shared/logger.ts";
import { confirmRerun } from "./confirm.ts";
import { buildReviewContext, prepareReviewContext } from "./context.ts";
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
import { createDetachedReviewWorkspace } from "./workspace.ts";

export async function runReview(
	config: ReviewerConfig,
	logger: Logger,
	dependencies: ReviewRunnerDependencies = {},
): Promise<ReviewRunOutput> {
	const bitbucket =
		dependencies.createBitbucketClient?.(config.bitbucket, logger) ??
		new BitbucketClient(config.bitbucket, logger);
	const prepareContext =
		dependencies.prepareReviewContext ?? prepareReviewContext;
	const buildContext = dependencies.buildReviewContext ?? buildReviewContext;
	const reviewWithCopilot = dependencies.runCopilotReview ?? runCopilotReview;
	const createReviewWorkspace =
		dependencies.createDetachedReviewWorkspace ?? createDetachedReviewWorkspace;
	const confirmRerunPrompt = dependencies.confirmRerun ?? confirmRerun;
	const initialPullRequest = await bitbucket.getPullRequest();

	logger.info(
		`Loaded pull request #${initialPullRequest.id} (${initialPullRequest.source.displayId} -> ${initialPullRequest.target.displayId})`,
	);

	const draftSkipReason = getPullRequestDraftSkipReason(initialPullRequest);
	if (draftSkipReason) {
		logger.info(draftSkipReason);
		return buildSkippedReviewOutput(
			config,
			initialPullRequest,
			draftSkipReason,
		);
	}

	if (initialPullRequest.state && initialPullRequest.state !== "OPEN") {
		const skipReason = `Skipping review because pull request #${initialPullRequest.id} is ${initialPullRequest.state}.`;
		logger.info(skipReason);
		return buildSkippedReviewOutput(config, initialPullRequest, skipReason);
	}

	const prepared = await prepareContext(config, logger, initialPullRequest);
	const effectiveConfig = prepared.config;
	const branchSkipReason = getPullRequestBranchSkipReason(
		initialPullRequest,
		effectiveConfig.review.skipBranchPrefixes,
	);
	if (branchSkipReason) {
		logger.info(branchSkipReason);
		return buildSkippedReviewOutput(
			effectiveConfig,
			initialPullRequest,
			branchSkipReason,
			undefined,
			prepared.mergeBaseCommit,
		);
	}
	const context = await buildContext(prepared, logger, initialPullRequest);
	const git = prepared.git;
	logger.info("Starting review run", {
		prId: context.pr.id,
		reviewRevision: context.reviewRevision,
		headCommit: context.headCommit,
		model: effectiveConfig.copilot.model,
		dryRun: effectiveConfig.review.dryRun,
	});
	logger.info(
		`Review scope after file filtering: ${context.reviewableFiles.length} reviewable out of ${context.diffStats.fileCount} changed files.`,
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

	const shouldUseDetachedReviewWorkspace =
		dependencies.createDetachedReviewWorkspace !== undefined ||
		dependencies.runCopilotReview === undefined;
	let detachedWorkspace:
		| Awaited<ReturnType<typeof createReviewWorkspace>>
		| undefined;
	let review: Awaited<ReturnType<typeof reviewWithCopilot>>;
	try {
		if (shouldUseDetachedReviewWorkspace) {
			detachedWorkspace = await createReviewWorkspace({
				repoRoot: effectiveConfig.repoRoot,
				commit: context.baseCommit,
				logger,
			});
			logger.info(
				`Using detached review workspace ${detachedWorkspace.workspaceRoot} for trusted base ${context.baseCommit}`,
			);
		}

		const reviewRepoRoot =
			detachedWorkspace?.workspaceRoot ?? effectiveConfig.repoRoot;
		const reviewGit = detachedWorkspace
			? new GitRepository(reviewRepoRoot, logger, effectiveConfig.gitRemoteName)
			: git;
		review = await reviewWithCopilot(
			shouldUseDetachedReviewWorkspace
				? {
						...effectiveConfig,
						repoRoot: reviewRepoRoot,
					}
				: effectiveConfig,
			shouldUseDetachedReviewWorkspace
				? {
						...context,
						repoRoot: reviewRepoRoot,
					}
				: context,
			reviewGit,
			logger,
		);
	} finally {
		if (detachedWorkspace) {
			try {
				await detachedWorkspace.cleanup();
				logger.info(
					`Removed detached review workspace ${detachedWorkspace.workspaceRoot}`,
				);
			} catch (error) {
				logger.warn(
					`Failed to clean up detached review workspace ${detachedWorkspace.workspaceRoot}`,
					error,
				);
			}
		}
	}
	const artifacts = buildReviewArtifacts(effectiveConfig, context, review);
	const publishResult = await publishReview(
		bitbucket,
		effectiveConfig,
		context,
		review,
		artifacts,
		logger,
	);
	const reviewWithTelemetry = {
		...publishResult.review,
		gitTelemetry: git.getTelemetrySnapshot(),
	};
	logger.info("Completed review run", {
		prId: context.pr.id,
		reviewRevision: context.reviewRevision,
		findings: publishResult.review.findings.length,
		publicationStatus: publishResult.publication.status,
	});

	return buildReviewRunOutput(
		context,
		reviewWithTelemetry,
		artifacts,
		publishResult.published,
		publishResult.publication,
	);
}
