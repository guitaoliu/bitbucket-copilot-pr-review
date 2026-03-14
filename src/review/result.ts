import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import {
	buildInsightAnnotations,
	buildInsightReport,
	buildPullRequestComment,
} from "../insights.ts";
import type { ReviewRunOutput } from "./output-types.ts";
import type { ReviewArtifacts } from "./runner-types.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";

export function buildSkippedReviewOutput(
	config: ReviewerConfig,
	pullRequest: PullRequestInfo,
	skipReason: string,
	reviewRevision?: string,
	mergeBaseCommit?: string,
): ReviewRunOutput {
	return {
		context: {
			prId: pullRequest.id,
			title: pullRequest.title,
			sourceBranch: pullRequest.source.displayId,
			targetBranch: pullRequest.target.displayId,
			headCommit: pullRequest.source.latestCommit,
			mergeBaseCommit: mergeBaseCommit ?? pullRequest.target.latestCommit,
			...(reviewRevision ? { reviewRevision } : {}),
			reviewedFiles: 0,
			skippedFiles: 0,
		},
		review: {
			summary: skipReason,
			findings: [],
			stale: false,
		},
		report: {
			title: config.report.title,
			result: "PASS",
			reporter: config.report.reporter,
		},
		annotations: [],
		published: false,
		skipped: true,
		skipReason,
	};
}

export function buildReviewArtifacts(
	config: ReviewerConfig,
	context: ReviewContext,
	review: ReviewOutcome,
): ReviewArtifacts {
	return {
		report: buildInsightReport(config, context, review),
		annotations: buildInsightAnnotations(config, review.findings),
		commentBody: buildPullRequestComment(config, context, review),
	};
}

export function buildReviewRunOutput(
	context: ReviewContext,
	review: ReviewOutcome,
	artifacts: ReviewArtifacts,
	published: boolean,
): ReviewRunOutput {
	return {
		context: {
			prId: context.pr.id,
			title: context.pr.title,
			sourceBranch: context.pr.source.displayId,
			targetBranch: context.pr.target.displayId,
			headCommit: context.headCommit,
			mergeBaseCommit: context.mergeBaseCommit,
			...(context.reviewRevision
				? { reviewRevision: context.reviewRevision }
				: {}),
			reviewedFiles: context.reviewedFiles.length,
			skippedFiles: context.skippedFiles.length,
		},
		review,
		report: artifacts.report,
		annotations: artifacts.annotations,
		commentBody: artifacts.commentBody,
		published,
		skipped: false,
	};
}
