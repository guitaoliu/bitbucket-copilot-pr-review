import type { CommentRetirement } from "../../bitbucket/types.ts";
import type { ReviewerConfig } from "../../config/types.ts";
import type { ReviewFinding } from "../../policy/types.ts";
import {
	BITBUCKET_PR_COMMENT_MAX_CHARS,
	truncateText,
} from "../../shared/text.ts";
import { formatCommentTagMarker, formatRevisionMarker } from "../markers.ts";
import { buildDefaultPullRequestSummary } from "../summary.ts";
import type {
	ChangeAreaSummary,
	ReviewContext,
	ReviewOutcome,
} from "../types.ts";
import {
	buildPullRequestDiffLink,
	formatCommentReference,
	formatFindingListLines,
	formatFindingLocation,
	formatFindingTypeSummary,
	pluralize,
} from "./markdown.ts";

const COMMENT_SECTION_SEPARATOR = "\n\n";

export const SUMMARY_COMMENT_RETIREMENT: CommentRetirement = {
	label: "pull request summary comment",
	supersededText:
		"_Superseded by a newer automated PR review summary. This thread is preserved because Bitbucket will not delete it._",
};

function buildFindingHeaderLines(findings: ReviewFinding[]): string[] {
	if (findings.length === 0) {
		return ["- No validated reportable issues were published."];
	}

	const typeSummary = formatFindingTypeSummary(findings);
	const findingSummary = `${findings.length} reportable ${pluralize(findings.length, "issue")}`;
	return [
		typeSummary ? `- ${findingSummary}: ${typeSummary}` : `- ${findingSummary}`,
	];
}

function getDirectoryName(path: string): string {
	const lastSeparatorIndex = path.lastIndexOf("/");
	return lastSeparatorIndex >= 0 ? path.slice(0, lastSeparatorIndex) : "";
}

function formatGroupedPathLabel(paths: string[]): string {
	const firstDirectory = getDirectoryName(paths[0] ?? "");
	if (paths.some((path) => getDirectoryName(path) !== firstDirectory)) {
		return `{${paths.join(",")}}`;
	}

	const names = paths
		.map((path) => path.slice(path.lastIndexOf("/") + 1))
		.join(",");
	return firstDirectory ? `${firstDirectory}/{${names}}` : `{${names}}`;
}

function formatChangeAreaPathReference(
	area: ChangeAreaSummary,
	context: ReviewContext,
): string {
	if (area.paths.length !== 1) {
		return formatCommentReference(
			formatGroupedPathLabel(area.paths),
			undefined,
		);
	}

	const path = area.paths[0] ?? "";
	const reviewedFile = context.reviewableFiles.some(
		(file) => file.path === path,
	);
	return formatCommentReference(
		path,
		reviewedFile ? buildPullRequestDiffLink(context.pr.link, path) : undefined,
	);
}

function joinSections(sections: string[]): string {
	return sections
		.map((section) => section.trim())
		.filter((section) => section.length > 0)
		.join(COMMENT_SECTION_SEPARATOR);
}

function fitCommentSection(options: {
	baseSections: string[];
	heading: string;
	pinnedLines?: string[];
	lines: string[];
	omittedLabel: string;
}): string | undefined {
	if (options.lines.length === 0 && (options.pinnedLines?.length ?? 0) === 0) {
		return undefined;
	}

	for (
		let visibleCount = options.lines.length;
		visibleCount >= 0;
		visibleCount -= 1
	) {
		const omittedCount = options.lines.length - visibleCount;
		const section = [
			options.heading,
			...(options.pinnedLines ?? []),
			...options.lines.slice(0, visibleCount),
			...(omittedCount > 0
				? [
						`- ... ${omittedCount} more ${options.omittedLabel} omitted to fit Bitbucket comment limit.`,
					]
				: []),
		].join("\n");
		if (
			joinSections([...options.baseSections, section]).length <=
			BITBUCKET_PR_COMMENT_MAX_CHARS
		) {
			return section;
		}
	}

	return undefined;
}

function buildReviewScopeSection(context: ReviewContext): string {
	const prLabel = `#${context.pr.id} ${context.pr.title}`;
	return [
		"### Review Scope",
		`- PR: ${formatCommentReference(prLabel, context.pr.link, false)}; branches: \`${context.pr.source.displayId}\` -> \`${context.pr.target.displayId}\`; diff: ${context.diffStats.fileCount} ${pluralize(context.diffStats.fileCount, "file")} (+${context.diffStats.additions}/-${context.diffStats.deletions}); reviewable: ${context.reviewableFiles.length}.`,
	].join("\n");
}

export function buildPullRequestComment(
	config: ReviewerConfig,
	context: ReviewContext,
	review: ReviewOutcome,
): string {
	const tag = config.report.commentTag;
	const leadingSections = [
		formatCommentTagMarker(tag),
		formatRevisionMarker(tag, context.reviewRevision),
		`## ${config.report.title}`,
		[
			"### What Changed",
			review.prSummary ?? buildDefaultPullRequestSummary(context),
		].join("\n"),
	];
	const reviewScope = buildReviewScopeSection(context);

	const findingsSection = fitCommentSection({
		baseSections: [...leadingSections, reviewScope],
		heading: "### Findings",
		pinnedLines: buildFindingHeaderLines(review.findings),
		lines: formatFindingListLines(review.findings, (finding) =>
			formatCommentReference(
				formatFindingLocation(finding),
				buildPullRequestDiffLink(context.pr.link, finding.path, finding.line),
			),
		),
		omittedLabel: pluralize(review.findings.length, "finding"),
	});
	const sectionsWithFindings = findingsSection
		? [...leadingSections, findingsSection]
		: leadingSections;
	const changeAreas = review.changeAreas ?? [];
	const changeAreasSection = fitCommentSection({
		baseSections: [...sectionsWithFindings, reviewScope],
		heading: "### Change Areas",
		lines: changeAreas.map(
			(area) =>
				`- ${area.title} (${formatChangeAreaPathReference(area, context)}): ${area.summary}`,
		),
		omittedLabel: pluralize(changeAreas.length, "change area"),
	});

	return truncateText(
		joinSections([
			...sectionsWithFindings,
			...(changeAreasSection ? [changeAreasSection] : []),
			reviewScope,
		]),
		BITBUCKET_PR_COMMENT_MAX_CHARS,
		{ preserveMaxLength: true },
	);
}
