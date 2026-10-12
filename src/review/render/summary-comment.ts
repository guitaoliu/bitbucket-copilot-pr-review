import type { CommentRetirement } from "../../bitbucket/types.ts";
import type { ReviewerConfig } from "../../config/types.ts";
import { filterFilesByPathPattern } from "../../policy/path-access.ts";
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

const MAX_SCOPE_ROOTS = 3;
const MAX_SCOPE_DIRECTORY_SEGMENTS = 3;

function parentDirectorySegments(filePath: string): string[] {
	return filePath.split("/").slice(0, -1);
}

function commonPrefix(segmentLists: string[][]): string[] {
	const [first = [], ...rest] = segmentLists;
	let length = first.length;
	for (const segments of rest) {
		let shared = 0;
		while (shared < length && segments[shared] === first[shared]) {
			shared += 1;
		}
		length = shared;
	}
	return first.slice(0, length);
}

function abbreviateDirectory(segments: string[]): string {
	return segments.length > MAX_SCOPE_DIRECTORY_SEGMENTS
		? `${segments[0]}/…/${segments.at(-1)}/`
		: `${segments.join("/")}/`;
}

function formatChangeAreaScope(
	area: ChangeAreaSummary,
	context: ReviewContext,
): string {
	const files = [
		...new Set(
			area.paths.flatMap((entry) =>
				filterFilesByPathPattern(context.reviewableFiles, entry).map(
					(file) => file.path,
				),
			),
		),
	];
	const [onlyFile] = files;
	if (onlyFile === undefined) {
		return formatCommentReference(area.paths.join(", "), undefined);
	}
	if (files.length === 1) {
		return formatCommentReference(
			onlyFile.slice(onlyFile.lastIndexOf("/") + 1),
			buildPullRequestDiffLink(context.pr.link, onlyFile),
		);
	}

	const common = commonPrefix(files.map(parentDirectorySegments));
	const roots =
		common.length > 0
			? [abbreviateDirectory(common)]
			: [
					...new Set(
						files.map((file) => {
							const [root = file, ...rest] = file.split("/");
							return rest.length > 0 ? `${root}/` : root;
						}),
					),
				];
	const visibleRoots = roots
		.slice(0, MAX_SCOPE_ROOTS)
		.map((root) => formatCommentReference(root, undefined));
	const more = roots.length > MAX_SCOPE_ROOTS ? ", …" : "";
	return `${visibleRoots.join(", ")}${more}; ${files.length} ${pluralize(files.length, "file")}`;
}

function formatChangeAreaLine(
	area: ChangeAreaSummary,
	context: ReviewContext,
): string {
	return `- **${area.title.replace(/\*/g, "\\*")}** (${formatChangeAreaScope(area, context)}): ${area.summary}`;
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
		lines: changeAreas.map((area) => formatChangeAreaLine(area, context)),
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
