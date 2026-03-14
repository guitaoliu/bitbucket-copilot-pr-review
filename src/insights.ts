import type {
	InsightAnnotationPayload,
	InsightReportDataField,
	InsightReportPayload,
} from "./bitbucket/types.ts";
import type { ReviewerConfig } from "./config/types.ts";
import type { ChangedFile, SkippedFile } from "./git/types.ts";
import {
	buildPullRequestCommentMetadataMarkers,
	buildPullRequestCommentTagMarker,
	buildReviewMetadataFields,
} from "./review/publication-state.ts";
import {
	buildDefaultPullRequestSummary,
	buildSkippedFileSummary,
	summarizeSkippedReason,
} from "./review/summary.ts";
import type {
	ReviewContext,
	ReviewFinding,
	ReviewOutcome,
} from "./review/types.ts";
import { omitUndefined } from "./shared/object.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS, truncateText } from "./shared/text.ts";

const FILE_STATUS_ORDER = [
	"added",
	"modified",
	"renamed",
	"copied",
	"deleted",
] as const;
const SKIP_REASON_ORDER = [
	"deleted file",
	"binary diff",
	"generated or vendored path",
	"binary or generated extension",
	"ignored path pattern",
	"lockfile",
	"potential secret-bearing path",
	"empty textual diff",
] as const;
type FileLike = Pick<ChangedFile | SkippedFile, "path" | "oldPath" | "status">;

const COMMENT_SECTION_SEPARATOR = "\n\n";

function pluralize(
	count: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return count === 1 ? singular : plural;
}

function encodePullRequestDiffAnchorPath(filePath: string): string {
	return encodeURIComponent(filePath).replace(/%20/g, "+");
}

function buildPullRequestDiffLink(
	prLink: string | undefined,
	filePath: string,
	line?: number,
): string | undefined {
	if (!prLink) {
		return undefined;
	}

	const normalizedLink = prLink.replace(/\/$/, "");
	const anchor = encodePullRequestDiffAnchorPath(filePath);
	return `${normalizedLink}/diff#${anchor}${line && line > 0 ? `?t=${line}` : ""}`;
}

function formatCommentReference(
	label: string,
	link: string | undefined,
	fallbackAsCode = true,
): string {
	if (!link) {
		return fallbackAsCode ? `\`${label}\`` : label;
	}

	const safeLabel = label
		.replace(/\\/g, "\\\\")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]");
	return `[${safeLabel}](${link})`;
}

function buildAnnotationMetadataLine(finding: ReviewFinding): string {
	const parts = [
		`Severity: ${finding.severity}`,
		`Type: ${finding.type}`,
		`Confidence: ${finding.confidence}`,
	];

	if (finding.category) {
		parts.push(`Category: ${finding.category}`);
	}

	return parts.join(" | ");
}

function buildAnnotationMessage(finding: ReviewFinding): string {
	const parts = [finding.title, buildAnnotationMetadataLine(finding)];
	if (finding.details.length > 0) {
		parts.push(finding.details);
	}
	return truncateText(parts.join("\n"), 1800);
}

function buildFindingSummaryLines(findings: ReviewFinding[]): string[] {
	return findings.map((finding, index) => {
		const location =
			finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
		return `${index + 1}. [${finding.severity}/${finding.confidence}] ${location} - ${finding.title}`;
	});
}

function buildCommentFindingSummaryLines(
	prLink: string | undefined,
	findings: ReviewFinding[],
): string[] {
	return findings.map((finding, index) => {
		const locationLabel =
			finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
		const location = formatCommentReference(
			locationLabel,
			buildPullRequestDiffLink(prLink, finding.path, finding.line),
		);
		return `${index + 1}. [${finding.severity}/${finding.confidence}] ${location} - ${finding.title}`;
	});
}

function buildChangedFileStatusSummary(
	changedFiles: FileLike[],
): string | undefined {
	if (changedFiles.length === 0) {
		return undefined;
	}

	const counts = new Map<string, number>();
	for (const file of changedFiles) {
		counts.set(file.status, (counts.get(file.status) ?? 0) + 1);
	}

	const parts = FILE_STATUS_ORDER.flatMap((status) => {
		const count = counts.get(status) ?? 0;
		if (count === 0) {
			return [];
		}

		return `${count} ${pluralize(count, `${status} file`, `${status} files`)}`;
	});

	return parts.length > 0 ? parts.join(", ") : undefined;
}

function buildSkippedReasonSummary(
	skippedFiles: SkippedFile[],
): string | undefined {
	if (skippedFiles.length === 0) {
		return undefined;
	}

	const counts = new Map<string, number>();
	for (const file of skippedFiles) {
		const label = summarizeSkippedReason(file.reason);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}

	const orderedLabels = [
		...SKIP_REASON_ORDER.filter((reason) => counts.has(reason)),
		...[...counts.keys()]
			.filter(
				(reason) =>
					!SKIP_REASON_ORDER.includes(
						reason as (typeof SKIP_REASON_ORDER)[number],
					),
			)
			.sort(),
	];

	const parts = orderedLabels.map((reason) => {
		const count = counts.get(reason) ?? 0;
		return `${reason} (${count})`;
	});

	return parts.length > 0 ? parts.join(", ") : undefined;
}

function buildPrIntentSection(
	context: ReviewContext,
	outcome: ReviewOutcome,
): string {
	return [
		"### Intent",
		outcome.prSummary ?? buildDefaultPullRequestSummary(context),
	].join("\n");
}

function buildFileChangeSummaryLines(
	context: ReviewContext,
	outcome: ReviewOutcome,
): string[] {
	const reviewedSummaryMap = new Map(
		(outcome.fileSummaries ?? []).map((entry) => [entry.path, entry.summary]),
	);

	const reviewedLines = context.reviewedFiles.map((file) => {
		const label = formatCommentReference(
			file.path,
			buildPullRequestDiffLink(context.pr.link, file.path),
		);
		return `- ${label}: ${reviewedSummaryMap.get(file.path) ?? "Reviewed change."}`;
	});

	if (reviewedLines.length === 0) {
		return ["- No changed files captured from the diff."];
	}

	return reviewedLines;
}

function buildSkippedFilesLines(context: ReviewContext): string[] {
	return context.skippedFiles.map((file) => {
		const label = formatCommentReference(
			file.path,
			buildPullRequestDiffLink(context.pr.link, file.path),
		);
		return `- ${label}: ${buildSkippedFileSummary(file)}`;
	});
}

function getCommentLengthWithSections(sections: string[]): number {
	return sections.join(COMMENT_SECTION_SEPARATOR).trim().length;
}

function fitCommentSection(options: {
	baseSections: string[];
	heading: string;
	lines: string[];
	omittedLabel: string;
	maxChars: number;
}): string | undefined {
	if (options.lines.length === 0) {
		return undefined;
	}

	const tryBuild = (visibleCount: number): string | undefined => {
		const omittedCount = options.lines.length - visibleCount;
		const sectionLines = options.lines.slice(0, visibleCount);
		if (omittedCount > 0) {
			sectionLines.push(
				`- ... ${omittedCount} more ${options.omittedLabel} omitted to fit Bitbucket comment limit.`,
			);
		}

		const section = [options.heading, ...sectionLines].join("\n");
		const nextSections = [...options.baseSections, section];
		return getCommentLengthWithSections(nextSections) <= options.maxChars
			? section
			: undefined;
	};

	for (
		let visibleCount = options.lines.length;
		visibleCount >= 0;
		visibleCount -= 1
	) {
		const section = tryBuild(visibleCount);
		if (section) {
			return section;
		}
	}

	return undefined;
}

function buildPullRequestSummarySection(context: ReviewContext): string {
	const changedFiles = [...context.reviewedFiles, ...context.skippedFiles];
	const changedFileStatusSummary = buildChangedFileStatusSummary(changedFiles);
	const skippedReasonSummary = buildSkippedReasonSummary(context.skippedFiles);
	const prLabel = `#${context.pr.id} ${context.pr.title}`;
	const lines = [
		"### Overview",
		`- PR: ${formatCommentReference(prLabel, context.pr.link, false)}`,
		`- Branch: \`${context.pr.source.displayId}\` -> \`${context.pr.target.displayId}\``,
		`- Diff: ${context.diffStats.fileCount} ${pluralize(context.diffStats.fileCount, "file")}, +${context.diffStats.additions}, -${context.diffStats.deletions}`,
		...(changedFileStatusSummary ? [`- Mix: ${changedFileStatusSummary}`] : []),
		`- Scope: ${context.reviewedFiles.length} reviewed, ${context.skippedFiles.length} skipped`,
		...(skippedReasonSummary ? [`- Skipped: ${skippedReasonSummary}`] : []),
	];

	return lines.join("\n");
}

function buildReportData(
	_config: ReviewerConfig,
	context: ReviewContext,
	outcome: ReviewOutcome,
): InsightReportDataField[] {
	return [
		{ title: "Findings", type: "NUMBER", value: outcome.findings.length },
		...buildReviewMetadataFields({
			revision: context.reviewRevision,
			reviewedCommit: context.headCommit,
		}),
		{
			title: "Reviewed files",
			type: "NUMBER",
			value: context.reviewedFiles.length,
		},
		{
			title: "Skipped files",
			type: "NUMBER",
			value: context.skippedFiles.length,
		},
	];
}

export function buildInsightReport(
	config: ReviewerConfig,
	context: ReviewContext,
	outcome: ReviewOutcome,
): InsightReportPayload {
	const findingSummary =
		outcome.findings.length > 0
			? `\n\nTop findings:\n${buildFindingSummaryLines(outcome.findings).join("\n")}`
			: "";
	const details = truncateText(
		`${outcome.summary}\n\nAdvisory AI review generated by GitHub Copilot in Jenkins. Findings are limited to reviewable changed files and changed lines.${findingSummary}`,
		1900,
	);
	const result: InsightReportPayload["result"] =
		outcome.findings.length > 0 ? "FAIL" : "PASS";

	return omitUndefined({
		title: config.report.title,
		details,
		result,
		reporter: config.report.reporter,
		link: config.report.link,
		data: buildReportData(config, context, outcome),
	}) satisfies InsightReportPayload;
}

export function buildInsightAnnotations(
	config: ReviewerConfig,
	findings: ReviewFinding[],
): InsightAnnotationPayload[] {
	return findings.map(
		(finding) =>
			omitUndefined({
				externalId: finding.externalId,
				path: finding.path,
				line: finding.line > 0 ? finding.line : undefined,
				message: buildAnnotationMessage(finding),
				severity: finding.severity,
				type: finding.type,
				link: config.report.link,
			}) satisfies InsightAnnotationPayload,
	);
}

export function buildPullRequestComment(
	config: ReviewerConfig,
	context: ReviewContext,
	outcome: ReviewOutcome,
): string {
	const header = buildPullRequestCommentTagMarker(config.report.commentTag);
	const metadataMarkers = buildPullRequestCommentMetadataMarkers({
		tag: config.report.commentTag,
		revision: context.reviewRevision,
		reviewedCommit: context.headCommit,
		publishedCommit: context.headCommit,
	});
	const summary = `## ${config.report.title}\n\n${outcome.summary}`;
	const prIntent = buildPrIntentSection(context, outcome);
	const prSummary = buildPullRequestSummarySection(context);
	const stableSections = [
		header,
		...metadataMarkers,
		summary,
		prIntent,
		prSummary,
	]
		.filter((section) => section && section.trim().length > 0)
		.map((section) => section.trim());

	const optionalSections: string[] = [];
	for (const [heading, lines, omittedLabel] of [
		[
			"### Findings",
			buildCommentFindingSummaryLines(context.pr.link, outcome.findings),
			pluralize(outcome.findings.length, "finding"),
		],
		[
			"### Files",
			buildFileChangeSummaryLines(context, outcome),
			pluralize(context.reviewedFiles.length, "file summary", "file summaries"),
		],
		[
			"### Skipped",
			buildSkippedFilesLines(context),
			pluralize(context.skippedFiles.length, "skipped file", "skipped files"),
		],
	] as const) {
		const section = fitCommentSection({
			baseSections: [...stableSections, ...optionalSections],
			heading,
			lines,
			omittedLabel,
			maxChars: BITBUCKET_PR_COMMENT_MAX_CHARS,
		});
		if (section) {
			optionalSections.push(section);
		}
	}

	return truncateText(
		[...stableSections, ...optionalSections]
			.join(COMMENT_SECTION_SEPARATOR)
			.trim(),
		BITBUCKET_PR_COMMENT_MAX_CHARS,
		{ preserveMaxLength: true },
	);
}
