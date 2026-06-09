import type { RawBitbucketCodeInsightsReport } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import {
	getInsightReportFindingCount,
	getInsightReportReviewedCommit,
	getInsightReportReviewRevision,
	getInsightReportReviewSchema,
	parsePullRequestCommentMetadata,
	rewritePullRequestCommentMetadata,
} from "./publication-state.ts";
import { buildReviewArtifacts } from "./result.ts";
import { getReviewRevisionSchema } from "./revision.ts";
import type { ReviewArtifacts, ReviewBitbucketClient } from "./runner-types.ts";
import type {
	ReviewContext,
	ReviewFinding,
	ReviewOutcome,
	StoredReviewFinding,
} from "./types.ts";

type StoredComment = Awaited<
	ReturnType<ReviewBitbucketClient["findPullRequestCommentByTag"]>
>;

export interface ExistingPublicationStatus {
	existingReport: RawBitbucketCodeInsightsReport | undefined;
	existingComment: StoredComment;
	commentStoredFindings?: StoredReviewFinding[];
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
	action: "skip" | "republish" | "review";
	reason?: string;
	repairWarning?: string;
	confirmMessage?: string;
	reusedReview?: ReviewOutcome;
	reusedArtifacts?: ReviewArtifacts;
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

function summarizeReportDetails(
	report: RawBitbucketCodeInsightsReport | undefined,
): string {
	const details = report?.details?.trim();
	if (!details) {
		return "Reused the existing review artifacts for an unchanged PR revision.";
	}

	return (
		details
			.split(/\n\nAdvisory AI review generated/)[0]
			?.split(/\n\nTop findings:/)[0]
			?.trim() ||
		"Reused the existing review artifacts for an unchanged PR revision."
	);
}

function buildReviewFindingFromStoredFinding(
	finding: StoredReviewFinding,
	index: number,
	config: ReviewerConfig,
): ReviewFinding {
	return {
		externalId: finding.externalId ?? `reused-finding-${index + 1}`,
		path: finding.path,
		line: finding.line ?? 0,
		severity: finding.severity,
		type: finding.type,
		confidence: finding.confidence ?? config.review.minConfidence,
		title: finding.title,
		details: finding.details ?? "",
		...(finding.category ? { category: finding.category } : {}),
	};
}

function getReusableStoredFindings(
	context: ReviewContext,
	status: ExistingPublicationStatus,
): StoredReviewFinding[] | undefined {
	if (status.commentRevision !== context.reviewRevision) {
		return undefined;
	}

	if (
		!status.reportCommit ||
		status.commentReviewedCommit !== status.reportCommit
	) {
		return undefined;
	}

	return status.commentStoredFindings ?? [];
}

function buildReviewOutcomeFromArtifacts(
	context: ReviewContext,
	status: ExistingPublicationStatus,
	config: ReviewerConfig,
): ReviewOutcome {
	const storedFindings = getReusableStoredFindings(context, status) ?? [];

	return {
		summary: summarizeReportDetails(status.existingReport),
		findings: storedFindings.map((finding, index) =>
			buildReviewFindingFromStoredFinding(finding, index, config),
		),
		stale: false,
		fileSummaries: [],
	};
}

function canReuseExistingArtifacts(
	context: ReviewContext,
	status: ExistingPublicationStatus,
): boolean {
	if (!status.existingReport || !status.reportCommit) {
		return false;
	}

	if (status.reportSchema !== getReviewRevisionSchema()) {
		return false;
	}

	if (status.reportRevision !== context.reviewRevision) {
		return false;
	}

	if (status.reportReviewedCommit !== status.reportCommit) {
		return false;
	}

	const expectedAnnotationCount = getInsightReportFindingCount(
		status.existingReport,
	);
	if (expectedAnnotationCount === undefined) {
		return false;
	}

	const reusableStoredFindings = getReusableStoredFindings(context, status);

	return reusableStoredFindings?.length === expectedAnnotationCount;
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
		storedFindingCount: number;
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
	} else if (status.storedFindingCount !== status.expectedAnnotationCount) {
		reasons.push(
			`stored finding count ${status.storedFindingCount} != findings ${status.expectedAnnotationCount}`,
		);
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
	const candidateReportCommit =
		commentMetadata?.reviewedCommit ?? context.headCommit;

	let reportCommit = context.headCommit;
	let existingReport = await bitbucket.getCodeInsightsReport(
		context.headCommit,
		config.report.key,
	);

	if (!existingReport && candidateReportCommit !== context.headCommit) {
		existingReport = await bitbucket.getCodeInsightsReport(
			candidateReportCommit,
			config.report.key,
		);
		reportCommit = candidateReportCommit;
	}

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
		expectedAnnotationCount !== undefined &&
		(commentMetadata?.storedFindings?.length ?? 0) === expectedAnnotationCount;
	const unusableReasons = existingReport
		? buildUnusableReasons(context, {
				reportCommit,
				storedFindingCount: commentMetadata?.storedFindings?.length ?? 0,
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
		...(commentMetadata?.storedFindings
			? { commentStoredFindings: commentMetadata.storedFindings }
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

	if (canReuseExistingArtifacts(context, status)) {
		const reusedReview = buildReviewOutcomeFromArtifacts(
			context,
			status,
			config,
		);
		const reusedArtifacts = buildReviewArtifacts(config, context, reusedReview);
		const commentBody = status.existingComment
			? rewritePullRequestCommentMetadata(status.existingComment.text, {
					tag: config.report.commentTag,
					revision: context.reviewRevision,
					reviewedCommit: context.headCommit,
					publishedCommit: context.headCommit,
					...(status.commentStoredFindings
						? {
								findingsJson: JSON.stringify(status.commentStoredFindings),
							}
						: {}),
				})
			: reusedArtifacts.commentBody;

		return {
			action: "republish",
			repairWarning:
				status.reportCommit === context.headCommit
					? `Repairing the published artifacts for unchanged PR revision ${context.reviewRevision} on head ${context.headCommit} without rerunning review.`
					: `Reusing the existing review for unchanged PR revision ${context.reviewRevision} from head ${status.reportCommit} and republishing it onto head ${context.headCommit}.`,
			reusedReview,
			reusedArtifacts: {
				report: reusedArtifacts.report,
				commentBody,
			},
		};
	}

	if (status.existingReport) {
		const reasonSuffix =
			status.unusableReasons.length > 0
				? ` Details: ${status.unusableReasons.join("; ")}.`
				: "";
		const confirmMessage = shouldConfirmRerun(context, status)
			? `Existing cached artifacts for PR revision ${context.reviewRevision} look unusable. ${status.unusableReasons.join("; ") || "No additional details available."}`
			: undefined;
		return {
			action: "review",
			repairWarning: `Found an existing but unusable report ${config.report.key} for revision ${context.reviewRevision}; rerunning review to refresh the published output.${reasonSuffix}`,
			...(confirmMessage ? { confirmMessage } : {}),
		};
	}

	return { action: "review" };
}
