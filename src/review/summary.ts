import { sanitizeModelAuthoredText, truncateText } from "../shared/text.ts";
import type {
	ChangeAreaSummary,
	ReviewContext,
	ReviewSummaryDrafts,
} from "./types.ts";

const MAX_PR_SUMMARY_LENGTH = 1200;

function collapseWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function normalizeInlineSummaryText(
	value: string | undefined,
	maxChars: number,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const collapsed = sanitizeModelAuthoredText(collapseWhitespace(value));
	if (collapsed.length === 0) {
		return undefined;
	}

	return truncateText(collapsed, maxChars, { preserveMaxLength: true });
}

function normalizeMultilineSummaryText(
	value: string | undefined,
	maxChars: number,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => collapseWhitespace(line))
		.map((line) => sanitizeModelAuthoredText(line))
		.filter((line) => line.length > 0)
		.join("\n");
	if (normalized.length === 0) {
		return undefined;
	}

	return truncateText(normalized, maxChars, { preserveMaxLength: true });
}

export function buildDefaultPullRequestSummary(context: ReviewContext): string {
	const title = normalizeInlineSummaryText(
		context.pr.title,
		MAX_PR_SUMMARY_LENGTH,
	);
	const description = normalizeInlineSummaryText(
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

export function finalizeReviewSummary(
	context: ReviewContext,
	drafts: ReviewSummaryDrafts,
): {
	prSummary: string;
	changeAreas: ChangeAreaSummary[];
} {
	const prSummary =
		normalizeMultilineSummaryText(drafts.prSummary, MAX_PR_SUMMARY_LENGTH) ??
		buildDefaultPullRequestSummary(context);

	return {
		prSummary,
		changeAreas: drafts.changeAreas ?? [],
	};
}
