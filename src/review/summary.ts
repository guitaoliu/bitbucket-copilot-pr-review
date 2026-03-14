import type { ChangedFile, SkippedFile } from "../git/types.ts";
import { truncateText } from "../shared/text.ts";
import { createReviewedFileLookup } from "./file.ts";
import type {
	FileChangeSummary,
	ReviewContext,
	ReviewSummaryDrafts,
} from "./types.ts";

const MAX_PR_SUMMARY_LENGTH = 500;
const MAX_FILE_SUMMARY_LENGTH = 220;

function collapseWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function normalizeSummaryText(
	value: string | undefined,
	maxChars: number,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const collapsed = collapseWhitespace(value);
	if (collapsed.length === 0) {
		return undefined;
	}

	return truncateText(collapsed, maxChars, { preserveMaxLength: true });
}

function pluralize(
	count: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return count === 1 ? singular : plural;
}

function buildDiffSizeSummary(additions: number, deletions: number): string {
	return `+${additions}/-${deletions}`;
}

export function summarizeSkippedReason(reason: string): string {
	if (reason.startsWith("exceeds REVIEW_MAX_FILES limit")) {
		return "max-files limit";
	}

	if (reason.startsWith("ignored path pattern (")) {
		return "ignored path pattern";
	}

	return reason;
}

export function buildDefaultPullRequestSummary(context: ReviewContext): string {
	const title = normalizeSummaryText(context.pr.title, MAX_PR_SUMMARY_LENGTH);
	const description = normalizeSummaryText(
		context.pr.description,
		MAX_PR_SUMMARY_LENGTH,
	);

	if (
		title &&
		description &&
		description.toLowerCase() !== title.toLowerCase()
	) {
		return truncateText(`${title}. ${description}`, MAX_PR_SUMMARY_LENGTH, {
			preserveMaxLength: true,
		});
	}

	if (title) {
		return title;
	}

	if (description) {
		return description;
	}

	return `Prepares ${context.pr.source.displayId} for merge into ${context.pr.target.displayId}.`;
}

export function buildDefaultReviewedFileSummary(file: ChangedFile): string {
	const diffSize = buildDiffSizeSummary(file.additions, file.deletions);
	const changedLineSummary = `${file.changedLines.length} changed ${pluralize(file.changedLines.length, "line")}`;

	switch (file.status) {
		case "added":
			return `Adds this file (${diffSize}, ${changedLineSummary}).`;
		case "deleted":
			return `Deletes this file (${diffSize}, ${changedLineSummary}).`;
		case "renamed":
			return `${file.oldPath ? `Renamed from ${file.oldPath}` : "Renamed"}; updates ${changedLineSummary} (${diffSize}).`;
		case "copied":
			return `${file.oldPath ? `Copied from ${file.oldPath}` : "Copied"}; updates ${changedLineSummary} (${diffSize}).`;
		default:
			return `Updates ${changedLineSummary} (${diffSize}).`;
	}
}

export function buildSkippedFileSummary(file: SkippedFile): string {
	const reason = summarizeSkippedReason(file.reason);

	switch (file.status) {
		case "added":
			return reason;
		case "deleted":
			return reason;
		case "renamed":
			return file.oldPath ? `renamed from ${file.oldPath}; ${reason}` : reason;
		case "copied":
			return file.oldPath ? `copied from ${file.oldPath}; ${reason}` : reason;
		default:
			return reason;
	}
}

export function finalizeReviewSummary(
	context: ReviewContext,
	drafts: ReviewSummaryDrafts,
): Pick<ReviewSummaryDrafts, "prSummary" | "fileSummaries"> {
	const reviewedFileMap = createReviewedFileLookup(context.reviewedFiles);
	const normalizedFileSummaries = new Map<string, string>();

	for (const draft of drafts.fileSummaries) {
		const file = reviewedFileMap.get(draft.path);
		const summary = normalizeSummaryText(
			draft.summary,
			MAX_FILE_SUMMARY_LENGTH,
		);
		if (!file || !summary) {
			continue;
		}

		normalizedFileSummaries.set(file.path, summary);
	}

	const fileSummaries: FileChangeSummary[] = context.reviewedFiles.map(
		(file) => ({
			path: file.path,
			summary:
				normalizedFileSummaries.get(file.path) ??
				buildDefaultReviewedFileSummary(file),
		}),
	);

	return {
		prSummary:
			normalizeSummaryText(drafts.prSummary, MAX_PR_SUMMARY_LENGTH) ??
			buildDefaultPullRequestSummary(context),
		fileSummaries,
	};
}
