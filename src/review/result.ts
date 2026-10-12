import packageJson from "../../package.json" with { type: "json" };
import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import { collectCurrentCodeKeys } from "../policy/finding-identity.ts";
import { omitUndefined } from "../shared/object.ts";
import { sanitizeModelAuthoredText } from "../shared/text.ts";
import type { ReviewPublication, ReviewRunOutput } from "./output-types.ts";
import { buildFindingCommentDrafts } from "./render/finding-comment.ts";
import { buildInsightReport } from "./render/report.ts";
import { buildPullRequestComment } from "./render/summary-comment.ts";
import type { ReviewArtifacts } from "./runner-types.ts";
import type {
	PublicationResult,
	ReviewContext,
	ReviewOutcome,
	ReviewScope,
} from "./types.ts";

export function buildSkippedReviewOutput({
	config,
	pullRequest,
	skipReason,
	reviewRevision,
	mergeBaseCommit,
}: {
	config: ReviewerConfig;
	pullRequest: PullRequestInfo;
	skipReason: string;
	reviewRevision?: string;
	mergeBaseCommit?: string;
}): ReviewRunOutput {
	return {
		context: {
			toolVersion: packageJson.version,
			prId: pullRequest.id,
			title: pullRequest.title,
			sourceBranch: pullRequest.source.displayId,
			targetBranch: pullRequest.target.displayId,
			headCommit: pullRequest.source.latestCommit,
			mergeBaseCommit: mergeBaseCommit ?? pullRequest.target.latestCommit,
			...(reviewRevision ? { reviewRevision } : {}),
			reviewableFiles: 0,
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
		published: false,
		skipped: true,
		skipReason,
	};
}

function sanitizeReviewOutcome(review: ReviewOutcome): ReviewOutcome {
	const sanitizeOptional = (value: string | undefined) =>
		value === undefined ? undefined : sanitizeModelAuthoredText(value);
	return omitUndefined({
		...review,
		summary: sanitizeModelAuthoredText(review.summary),
		findings: review.findings.map((finding) =>
			omitUndefined({
				...finding,
				title: sanitizeModelAuthoredText(finding.title),
				details: sanitizeModelAuthoredText(finding.details),
				category: sanitizeOptional(finding.category),
			}),
		),
		assistantMessage: sanitizeOptional(review.assistantMessage),
		prSummary: sanitizeOptional(review.prSummary),
		changeAreas: review.changeAreas?.map((area) => ({
			...area,
			title: sanitizeModelAuthoredText(area.title),
			summary: sanitizeModelAuthoredText(area.summary),
		})),
	}) satisfies ReviewOutcome;
}

export function buildReviewArtifacts(
	config: ReviewerConfig,
	scope: ReviewScope,
	rawReview: ReviewOutcome,
): ReviewArtifacts {
	const review = sanitizeReviewOutcome(rawReview);
	return {
		review,
		report: buildInsightReport(config, scope, review),
		commentBody: buildPullRequestComment(config, scope, review),
		findingComments: buildFindingCommentDrafts(
			config.report.commentTag,
			review.findings,
			scope.reviewableFiles,
		),
		currentCodeKeys: collectCurrentCodeKeys(scope.reviewableFiles),
	};
}

function toReviewPublication(result: PublicationResult): ReviewPublication {
	const completed = result.completedStages;
	return omitUndefined({
		status: result.status,
		attempted:
			completed.length > 0 ||
			(result.error !== undefined && result.error.stage !== "review"),
		codeInsightsPublished: completed.includes("code_insights"),
		findingCommentsUpdated: completed.includes("finding_comments"),
		pullRequestCommentUpdated: completed.includes("pull_request_comment"),
		error: result.error,
	}) satisfies ReviewPublication;
}

export function buildReviewRunOutput(
	context: ReviewContext,
	artifacts: ReviewArtifacts,
	publicationResult: PublicationResult,
): ReviewRunOutput {
	const {
		gitTelemetry,
		toolTelemetry,
		copilotUsage,
		...reviewWithoutTelemetry
	} = artifacts.review;
	const hasGitTelemetry =
		gitTelemetry !== undefined &&
		Object.keys(gitTelemetry.byOperation).length > 0;
	const publication = toReviewPublication(publicationResult);

	return {
		context: {
			toolVersion: packageJson.version,
			prId: context.pr.id,
			title: context.pr.title,
			sourceBranch: context.pr.source.displayId,
			targetBranch: context.pr.target.displayId,
			headCommit: context.headCommit,
			mergeBaseCommit: context.mergeBaseCommit,
			...(context.reviewRevision
				? { reviewRevision: context.reviewRevision }
				: {}),
			reviewableFiles: context.reviewableFiles.length,
		},
		...omitUndefined({
			metrics:
				hasGitTelemetry || toolTelemetry || copilotUsage
					? {
							...(hasGitTelemetry && gitTelemetry ? { gitTelemetry } : {}),
							...(toolTelemetry ? { toolTelemetry } : {}),
							...(copilotUsage ? { copilotUsage } : {}),
						}
					: undefined,
		}),
		review: {
			...reviewWithoutTelemetry,
			stale: publication.status === "stale",
		},
		report: artifacts.report,
		commentBody: artifacts.commentBody,
		published: publication.status === "published",
		publication,
		publicationStatus: publication.status,
		skipped: false,
	};
}
