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
const FINDING_TYPE_ORDER = ["BUG", "VULNERABILITY", "CODE_SMELL"] as const;
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
		`Type: ${finding.type}`,
		`Severity: ${finding.severity}`,
		`Confidence: ${finding.confidence}`,
	];

	if (finding.category) {
		parts.push(`Category: ${finding.category}`);
	}

	return parts.join(" | ");
}

function buildFindingBadge(finding: ReviewFinding): string {
	return `${finding.type}/${finding.severity}/${finding.confidence}`;
}

function buildFindingTypeSummary(
	findings: ReviewFinding[],
): string | undefined {
	if (findings.length === 0) {
		return undefined;
	}

	const counts = new Map<ReviewFinding["type"], number>();
	for (const finding of findings) {
		counts.set(finding.type, (counts.get(finding.type) ?? 0) + 1);
	}

	const parts = FINDING_TYPE_ORDER.flatMap((type) => {
		const count = counts.get(type) ?? 0;
		if (count === 0) {
			return [];
		}

		switch (type) {
			case "BUG":
				return `${count} ${pluralize(count, "bug")}`;
			case "VULNERABILITY":
				return `${count} ${pluralize(count, "vulnerability", "vulnerabilities")}`;
			case "CODE_SMELL":
				return `${count} ${pluralize(count, "code smell")}`;
			default:
				return [];
		}
	});

	return parts.length > 0 ? parts.join(", ") : undefined;
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
		return `${index + 1}. [${buildFindingBadge(finding)}] ${location} - ${finding.title}`;
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
		return `${index + 1}. [${buildFindingBadge(finding)}] ${location} - ${finding.title}`;
	});
}

function buildCommentFindingSummaryHeaderLines(
	findings: ReviewFinding[],
): string[] {
	if (findings.length === 0) {
		return [];
	}

	const typeSummary = buildFindingTypeSummary(findings);
	return typeSummary ? [`- Main risks: ${typeSummary}`] : [];
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

function buildReviewScopeDataValue(context: ReviewContext): string {
	return `${context.reviewedFiles.length} reviewed, ${context.skippedFiles.length} skipped`;
}

function buildPrIntentSection(
	context: ReviewContext,
	outcome: ReviewOutcome,
): string {
	return [
		"### What Changed",
		outcome.prSummary ?? buildDefaultPullRequestSummary(context),
	].join("\n");
}

function buildCommentConclusionSection(outcome: ReviewOutcome): string {
	const findingsCount = outcome.findings.length;
	const typeSummary = buildFindingTypeSummary(outcome.findings);

	return [
		"### Conclusion",
		outcome.summary,
		findingsCount > 0
			? `- Recommendation: address ${findingsCount} reportable ${pluralize(findingsCount, "issue")} before merge.`
			: "- Recommendation: no reportable issues found in the reviewed scope.",
		...(findingsCount > 0 && typeSummary
			? [`- Main risks: ${typeSummary}`]
			: []),
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
	pinnedLines?: string[];
	lines: string[];
	omittedLabel: string;
	maxChars: number;
}): string | undefined {
	if (options.lines.length === 0) {
		return undefined;
	}

	const tryBuild = (visibleCount: number): string | undefined => {
		const omittedCount = options.lines.length - visibleCount;
		const sectionLines = [
			...(options.pinnedLines ?? []),
			...options.lines.slice(0, visibleCount),
		];
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
		"### Review Scope",
		`- PR: ${formatCommentReference(prLabel, context.pr.link, false)}`,
		`- Branches: \`${context.pr.source.displayId}\` -> \`${context.pr.target.displayId}\``,
		`- Diff size: ${context.diffStats.fileCount} ${pluralize(context.diffStats.fileCount, "file")}, +${context.diffStats.additions}, -${context.diffStats.deletions}`,
		...(changedFileStatusSummary
			? [`- Change mix: ${changedFileStatusSummary}`]
			: []),
		`- Reviewed in scope: ${context.reviewedFiles.length} ${pluralize(context.reviewedFiles.length, "file")}`,
		`- Outside scope: ${context.skippedFiles.length} ${pluralize(context.skippedFiles.length, "file")}`,
		...(skippedReasonSummary
			? [`- Outside-scope reasons: ${skippedReasonSummary}`]
			: []),
	];

	return lines.join("\n");
}

function buildReportData(
	_config: ReviewerConfig,
	context: ReviewContext,
	outcome: ReviewOutcome,
): InsightReportDataField[] {
	const findingTypeSummary = buildFindingTypeSummary(outcome.findings);

	return [
		{ title: "Findings", type: "NUMBER", value: outcome.findings.length },
		...(findingTypeSummary
			? [
					{
						title: "Finding taxonomy",
						type: "TEXT" as const,
						value: findingTypeSummary,
					},
				]
			: []),
		...buildReviewMetadataFields({
			revision: context.reviewRevision,
			reviewedCommit: context.headCommit,
		}),
		{
			title: "Review scope",
			type: "TEXT",
			value: buildReviewScopeDataValue(context),
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
			? `\n\nTaxonomy: ${buildFindingTypeSummary(outcome.findings) ?? "reportable findings"}\n\nTop validated findings:\n${buildFindingSummaryLines(outcome.findings).join("\n")}`
			: "";
	const details = truncateText(
		`${outcome.summary}\n\nAdvisory AI review generated by GitHub Copilot. Only validated findings on reviewable changed files and changed lines are published.${findingSummary}`,
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
	const title = `## ${config.report.title}`;
	const conclusion = buildCommentConclusionSection(outcome);
	const prIntent = buildPrIntentSection(context, outcome);
	const prSummary = buildPullRequestSummarySection(context);
	const stableSections = [
		header,
		...metadataMarkers,
		title,
		conclusion,
		prIntent,
		prSummary,
	]
		.filter((section) => section && section.trim().length > 0)
		.map((section) => section.trim());

	const optionalSections: string[] = [];
	for (const [heading, lines, omittedLabel] of [
		[
			"### Main Concerns",
			buildCommentFindingSummaryLines(context.pr.link, outcome.findings),
			pluralize(outcome.findings.length, "finding"),
		],
		[
			"### Reviewed Changes",
			buildFileChangeSummaryLines(context, outcome),
			pluralize(context.reviewedFiles.length, "file summary", "file summaries"),
		],
		[
			"### Outside Review Scope",
			buildSkippedFilesLines(context),
			pluralize(context.skippedFiles.length, "skipped file", "skipped files"),
		],
	] as const) {
		const section = fitCommentSection({
			baseSections: [...stableSections, ...optionalSections],
			heading,
			...(heading === "### Main Concerns"
				? {
						pinnedLines: buildCommentFindingSummaryHeaderLines(
							outcome.findings,
						),
					}
				: {}),
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
