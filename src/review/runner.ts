import { createBitbucketClient } from "../bitbucket/client.ts";
import { resolveReviewerConfig } from "../config/load.ts";
import type { OperatorConfig } from "../config/types.ts";
import { runCopilotReview } from "../copilot/engine.ts";
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
	type ReviewRerunPlan,
} from "./skip-policy.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";
import { createDetachedReviewWorkspace } from "./workspace.ts";

const DEFAULT_DEPENDENCIES: ReviewRunnerDependencies = {
	createBitbucketClient,
	prepareReviewContext,
	buildReviewContext,
	runCopilotReview,
	createReviewWorkspace: createDetachedReviewWorkspace,
	confirmRerun,
};

export async function runReview(
	operatorConfig: OperatorConfig,
	logger: Logger,
	overrides: Partial<ReviewRunnerDependencies> = {},
): Promise<ReviewRunOutput> {
	const config = resolveReviewerConfig(operatorConfig);
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	const bitbucket = dependencies.createBitbucketClient(
		config.bitbucket,
		logger,
	);
	const initialPullRequest = await bitbucket.pullRequest.getPullRequest();

	logger.info(
		`Loaded pull request #${initialPullRequest.id} (${initialPullRequest.source.displayId} -> ${initialPullRequest.target.displayId})`,
	);

	const draftSkipReason = getPullRequestDraftSkipReason(initialPullRequest);
	if (draftSkipReason) {
		logger.info(draftSkipReason);
		return buildSkippedReviewOutput({
			config,
			pullRequest: initialPullRequest,
			skipReason: draftSkipReason,
		});
	}

	if (initialPullRequest.state && initialPullRequest.state !== "OPEN") {
		const skipReason = `Skipping review because pull request #${initialPullRequest.id} is ${initialPullRequest.state}.`;
		logger.info(skipReason);
		return buildSkippedReviewOutput({
			config,
			pullRequest: initialPullRequest,
			skipReason,
		});
	}

	const prepared = await dependencies.prepareReviewContext(
		operatorConfig,
		logger,
		initialPullRequest,
	);
	const effectiveConfig = prepared.config;
	const branchSkipReason = getPullRequestBranchSkipReason(
		initialPullRequest,
		effectiveConfig.review.skipBranchPrefixes,
	);
	if (branchSkipReason) {
		logger.info(branchSkipReason);
		return buildSkippedReviewOutput({
			config: effectiveConfig,
			pullRequest: initialPullRequest,
			skipReason: branchSkipReason,
			mergeBaseCommit: prepared.mergeBaseCommit,
		});
	}
	const context = await dependencies.buildReviewContext(
		prepared,
		logger,
		initialPullRequest,
	);
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
	const skipReason =
		reusePlan.action === "skip"
			? reusePlan.reason
			: await getDeclinedRerunReason(reusePlan, dependencies, logger, context);
	if (skipReason) {
		logger.info(skipReason);
		return buildSkippedReviewOutput({
			config: effectiveConfig,
			pullRequest: initialPullRequest,
			skipReason,
			reviewRevision: context.reviewRevision,
			mergeBaseCommit: context.mergeBaseCommit,
		});
	}

	const workspace = await dependencies.createReviewWorkspace({
		repoRoot: effectiveConfig.repoRoot,
		commit: context.baseCommit,
		logger,
	});
	logger.info(
		`Using detached review workspace ${workspace.workspaceRoot} for trusted base ${context.baseCommit}`,
	);
	let review: ReviewOutcome;
	try {
		review = await dependencies.runCopilotReview(
			{ ...effectiveConfig, repoRoot: workspace.workspaceRoot },
			{ ...context, repoRoot: workspace.workspaceRoot },
			git,
			logger,
		);
	} finally {
		try {
			await workspace.cleanup();
			logger.info(
				`Removed detached review workspace ${workspace.workspaceRoot}`,
			);
		} catch (error) {
			logger.warn(
				`Failed to clean up detached review workspace ${workspace.workspaceRoot}`,
				error,
			);
		}
	}
	const artifacts = buildReviewArtifacts(effectiveConfig, context, {
		...review,
		gitTelemetry: git.getTelemetrySnapshot(),
	});
	const publication = await publishReview(
		bitbucket,
		effectiveConfig,
		context,
		artifacts,
		logger,
	);
	logger.info("Completed review run", {
		prId: context.pr.id,
		reviewRevision: context.reviewRevision,
		findings: review.findings.length,
		publicationStatus: publication.status,
	});

	return buildReviewRunOutput(context, artifacts, publication);
}

async function getDeclinedRerunReason(
	plan: ReviewRerunPlan,
	dependencies: ReviewRunnerDependencies,
	logger: Logger,
	context: ReviewContext,
): Promise<string | undefined> {
	if (plan.repairWarning) {
		logger.warn(plan.repairWarning);
	}

	if (
		!plan.confirmMessage ||
		(await dependencies.confirmRerun({ message: plan.confirmMessage }))
	) {
		return undefined;
	}

	return `Skipped rerun for unchanged PR revision ${context.reviewRevision} after manual confirmation declined.`;
}
