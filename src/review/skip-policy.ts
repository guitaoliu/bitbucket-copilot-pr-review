import type { RawBitbucketCodeInsightsReport } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import {
	getInsightReportFindingCount,
	getInsightReportReviewedCommit,
	getInsightReportReviewRevision,
	getInsightReportReviewSchema,
	parsePullRequestCommentMetadata,
} from "./publication-state.ts";
import { getReviewRevisionSchema } from "./revision.ts";
import type { ReviewBitbucketClient } from "./runner-types.ts";
import type { ReviewContext } from "./types.ts";

type StoredComment = Awaited<
	ReturnType<ReviewBitbucketClient["findPullRequestCommentByTag"]>
>;

export interface ExistingPublicationStatus {
	existingReport: RawBitbucketCodeInsightsReport | undefined;
	existingComment: StoredComment;
	reportCommit?: string;
	existingPublicationComplete: boolean;
	reportRevision?: string;
	reportReviewedCommit?: string;
	reportSchema?: string;
	commentRevision?: string;
	commentPublishedCommit?: string;
	commentReviewedCommit?: string;
	unusableReasons: string[];
}

export interface ReviewReusePlan {
	action: "skip" | "review";
	reason?: string;
	repairWarning?: string;
	confirmMessage?: string;
}

function shouldConfirmRerun(
	context: ReviewContext,
	status: ExistingPublicationStatus,
): boolean {
	return (
		status.reportCommit === context.headCommit &&
		status.reportRevision === context.reviewRevision
	);
}

function buildUnusableReasons(
	context: ReviewContext,
	status: {
		reportCommit: string;
		reportSchema?: string;
		reportRevision?: string;
		reportReviewedCommit?: string;
		commentRevision?: string;
		commentReviewedCommit?: string;
		commentPublishedCommit?: string;
		expectedAnnotationCount?: number;
	},
): string[] {
	const reasons: string[] = [];

	if (status.reportSchema !== getReviewRevisionSchema()) {
		reasons.push(
			`report schema ${status.reportSchema ?? "missing"} != ${getReviewRevisionSchema()}`,
		);
	}

	if (status.reportRevision !== context.reviewRevision) {
		reasons.push(
			`report revision ${status.reportRevision ?? "missing"} != ${context.reviewRevision}`,
		);
	}

	if (status.reportReviewedCommit !== status.reportCommit) {
		reasons.push(
			`report reviewed commit ${status.reportReviewedCommit ?? "missing"} != stored report commit ${status.reportCommit}`,
		);
	}

	if (status.commentRevision !== context.reviewRevision) {
		reasons.push(
			`comment revision ${status.commentRevision ?? "missing"} != ${context.reviewRevision}`,
		);
	}

	if (status.commentReviewedCommit !== context.headCommit) {
		reasons.push(
			`comment reviewed commit ${status.commentReviewedCommit ?? "missing"} != ${context.headCommit}`,
		);
	}

	if (status.commentPublishedCommit !== context.headCommit) {
		reasons.push(
			`comment published commit ${status.commentPublishedCommit ?? "missing"} != ${context.headCommit}`,
		);
	}

	if (status.expectedAnnotationCount === undefined) {
		reasons.push("report findings field is missing or invalid");
	}

	return reasons;
}

export async function getExistingPublicationStatus(
	bitbucket: ReviewBitbucketClient,
	config: ReviewerConfig,
	context: ReviewContext,
): Promise<ExistingPublicationStatus> {
	const existingComment = await bitbucket.findPullRequestCommentByTag(
		config.report.commentTag,
	);
	const commentMetadata = existingComment
		? parsePullRequestCommentMetadata(
				config.report.commentTag,
				existingComment.text,
			)
		: undefined;
	const reportCommit = context.headCommit;
	const existingReport = await bitbucket.getCodeInsightsReport(
		context.headCommit,
		config.report.key,
	);

	const reportRevision = getInsightReportReviewRevision(existingReport);
	const reportReviewedCommit = getInsightReportReviewedCommit(existingReport);
	const reportSchema = getInsightReportReviewSchema(existingReport);
	const expectedAnnotationCount = getInsightReportFindingCount(existingReport);
	const existingPublicationComplete =
		reportCommit === context.headCommit &&
		reportSchema === getReviewRevisionSchema() &&
		reportRevision === context.reviewRevision &&
		reportReviewedCommit === context.headCommit &&
		commentMetadata?.revision === context.reviewRevision &&
		commentMetadata.reviewedCommit === context.headCommit &&
		commentMetadata.publishedCommit === context.headCommit &&
		expectedAnnotationCount !== undefined;
	const unusableReasons = existingReport
		? buildUnusableReasons(context, {
				reportCommit,
				...(reportSchema ? { reportSchema } : {}),
				...(reportRevision ? { reportRevision } : {}),
				...(reportReviewedCommit ? { reportReviewedCommit } : {}),
				...(commentMetadata?.revision
					? { commentRevision: commentMetadata.revision }
					: {}),
				...(commentMetadata?.reviewedCommit
					? { commentReviewedCommit: commentMetadata.reviewedCommit }
					: {}),
				...(commentMetadata?.publishedCommit
					? { commentPublishedCommit: commentMetadata.publishedCommit }
					: {}),
				...(expectedAnnotationCount !== undefined
					? { expectedAnnotationCount }
					: {}),
			})
		: [];

	return {
		existingReport,
		existingComment,
		existingPublicationComplete,
		...(existingReport ? { reportCommit } : {}),
		...(reportRevision ? { reportRevision } : {}),
		...(reportReviewedCommit ? { reportReviewedCommit } : {}),
		...(reportSchema ? { reportSchema } : {}),
		...(commentMetadata?.revision
			? { commentRevision: commentMetadata.revision }
			: {}),
		...(commentMetadata?.publishedCommit
			? { commentPublishedCommit: commentMetadata.publishedCommit }
			: {}),
		...(commentMetadata?.reviewedCommit
			? { commentReviewedCommit: commentMetadata.reviewedCommit }
			: {}),
		unusableReasons,
	};
}

export function buildReviewReusePlan(
	config: ReviewerConfig,
	context: ReviewContext,
	status: ExistingPublicationStatus,
): ReviewReusePlan {
	if (config.review.forceReview) {
		return { action: "review" };
	}

	if (status.existingPublicationComplete) {
		return {
			action: "skip",
			reason: `Skipping review because PR revision ${context.reviewRevision} already has a fully published report ${config.report.key} for head ${context.headCommit}. Use --force-review or REVIEW_FORCE=1 to override.`,
		};
	}

	if (status.existingReport) {
		const reasonSuffix =
			status.unusableReasons.length > 0
				? ` Details: ${status.unusableReasons.join("; ")}.`
				: "";
		const confirmMessage = shouldConfirmRerun(context, status)
			? `Existing published artifacts for PR revision ${context.reviewRevision} look unusable. ${status.unusableReasons.join("; ") || "No additional details available."}`
			: undefined;
		return {
			action: "review",
			repairWarning: `Found an existing but unusable report ${config.report.key} for revision ${context.reviewRevision}; rerunning review to refresh the published output.${reasonSuffix}`,
			...(confirmMessage ? { confirmMessage } : {}),
		};
	}

	return { action: "review" };
}
