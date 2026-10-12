import type { ReviewerConfig } from "../config/types.ts";
import { selectOwnTaggedComments } from "./comment-sync.ts";
import { parseSummaryCommentRevision } from "./markers.ts";
import {
	type PublishedReportState,
	readPublishedReportState,
} from "./publication-state.ts";
import type { ReviewBitbucketClient } from "./runner-types.ts";
import type { ReviewContext } from "./types.ts";

export interface ExistingPublicationStatus {
	report?: PublishedReportState;
	reasons: string[];
}

export type ReviewReusePlan =
	| { action: "skip"; reason: string }
	| ReviewRerunPlan;

export interface ReviewRerunPlan {
	action: "review";
	repairWarning?: string;
	confirmMessage?: string;
}

export async function getExistingPublicationStatus(
	bitbucket: ReviewBitbucketClient,
	config: ReviewerConfig,
	context: ReviewContext,
): Promise<ExistingPublicationStatus> {
	const tag = config.report.commentTag;
	const [rawReport, comments] = await Promise.all([
		bitbucket.codeInsights.getReport(context.headCommit, config.report.key),
		bitbucket.comments.listComments(),
	]);
	if (!rawReport) {
		return { reasons: [] };
	}

	const report = readPublishedReportState(rawReport);
	const [summaryComment] = selectOwnTaggedComments(
		tag,
		await bitbucket.getAuthenticatedUserName(),
		comments,
	).summaries;
	const commentRevision = summaryComment
		? parseSummaryCommentRevision(tag, summaryComment.text)
		: undefined;
	const reasons: string[] = [];
	if (report.revision !== context.reviewRevision) {
		reasons.push(
			`report revision ${report.revision ?? "missing"} != ${context.reviewRevision}`,
		);
	}
	if (commentRevision !== context.reviewRevision) {
		reasons.push(
			`comment revision ${commentRevision ?? "missing"} != ${context.reviewRevision}`,
		);
	}
	if (report.findingCount === undefined) {
		reasons.push("report findings field is missing or invalid");
	}

	return { report, reasons };
}

export function buildReviewReusePlan(
	config: ReviewerConfig,
	context: ReviewContext,
	status: ExistingPublicationStatus,
): ReviewReusePlan {
	if (config.review.forceReview || !status.report) {
		return { action: "review" };
	}

	if (status.reasons.length === 0) {
		return {
			action: "skip",
			reason: `Skipping review because PR revision ${context.reviewRevision} already has a fully published report ${config.report.key} for head ${context.headCommit}. Use --force-review or REVIEW_FORCE=1 to override.`,
		};
	}

	const details = status.reasons.join("; ");
	return {
		action: "review",
		repairWarning: `Found an existing but unusable report ${config.report.key} for revision ${context.reviewRevision}; rerunning review to refresh the published output. Details: ${details}.`,
		...(config.review.confirmRerun &&
		status.report.revision === context.reviewRevision
			? {
					confirmMessage: `Existing published artifacts for PR revision ${context.reviewRevision} look unusable. ${details}`,
				}
			: {}),
	};
}
