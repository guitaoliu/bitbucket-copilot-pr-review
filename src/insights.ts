import type {
	InsightReportDataField,
	InsightReportPayload,
} from "./bitbucket/types.ts";
import type { ReviewerConfig } from "./config/types.ts";
import { sanitizeReviewOutcomeForOutput } from "./review/output-sanitize.ts";
import {
	buildPullRequestCommentMetadataMarkers,
	buildPullRequestCommentTagMarker,
	buildReviewMetadataFields,
} from "./review/publication-state.ts";
import {
	buildDefaultPullRequestSummary,
	buildSkippedFileSummary,
	shouldCreatePerFileSummaries,
} from "./review/summary.ts";
import type {
	ReviewContext,
	ReviewFinding,
	ReviewOutcome,
	StoredReviewFinding,
} from "./review/types.ts";
import { omitUndefined } from "./shared/object.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS, truncateText } from "./shared/text.ts";

const FINDING_TYPE_ORDER = ["BUG", "VULNERABILITY", "CODE_SMELL"] as const;

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

function buildFindingBadge(finding: ReviewFinding): string {
	return `${finding.type}/${finding.severity}/${finding.confidence}`;
}

function buildCommentFindingMetadata(finding: ReviewFinding): string {
	return `Type: ${finding.type} | Severity: ${finding.severity} | Confidence: ${finding.confidence}`;
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

function buildFindingSummaryLines(findings: ReviewFinding[]): string[] {
	return findings.map((finding, index) => {
		const location =
			finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
		return `${index + 1}. [${buildFindingBadge(finding)}] ${location} - ${finding.title}`;
	});
}

function buildStoredFindingMetadata(
	findings: ReviewFinding[],
): string | undefined {
	if (findings.length === 0) {
		return undefined;
	}

	const storedFindings: StoredReviewFinding[] = findings.map(
		(finding) =>
			omitUndefined({
				path: finding.path,
				line: finding.line > 0 ? finding.line : undefined,
				severity: finding.severity,
				type: finding.type,
				confidence: finding.confidence,
				title: finding.title,
				details: finding.details.length > 0 ? finding.details : undefined,
				category: finding.category,
				externalId: finding.externalId,
				threadKey: finding.threadKey,
			}) satisfies StoredReviewFinding,
	);

	return JSON.stringify(storedFindings);
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
		return `${index + 1}. [${buildCommentFindingMetadata(finding)}] ${location} - ${finding.title}`;
	});
}

function buildCommentFindingHeaderLines(findings: ReviewFinding[]): string[] {
	if (findings.length === 0) {
		return ["- No reportable issues found."];
	}

	const typeSummary = buildFindingTypeSummary(findings);
	const findingsCount = findings.length;
	const findingSummary = `${findingsCount} reportable ${pluralize(findingsCount, "issue")}`;
	return typeSummary
		? [`- ${findingSummary}: ${typeSummary}`]
		: [`- ${findingSummary}`];
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

function buildFileChangeSummaryLines(
	context: ReviewContext,
	outcome: ReviewOutcome,
): string[] {
	if (!shouldCreatePerFileSummaries(context.reviewedFiles.length)) {
		return [];
	}

	const reviewedSummaryMap = new Map(
		(outcome.fileSummaries ?? []).map((entry) => [entry.path, entry.summary]),
	);

	const groups = new Map<string, string[]>();
	for (const file of context.reviewedFiles) {
		const summary = reviewedSummaryMap.get(file.path) ?? "Reviewed change.";
		const paths = groups.get(summary);
		if (paths) {
			paths.push(file.path);
		} else {
			groups.set(summary, [file.path]);
		}
	}

	const reviewedLines = [...groups].map(([summary, paths]) => {
		const label = formatFileSummaryReference(paths, context.pr.link);
		return `- ${label}: ${summary}`;
	});

	if (reviewedLines.length === 0) {
		return ["- No changed files captured from the diff."];
	}

	return reviewedLines;
}

function formatFileSummaryReference(
	paths: string[],
	prLink: string | undefined,
): string {
	if (paths.length === 1) {
		const path = paths[0] ?? "";
		return formatCommentReference(path, buildPullRequestDiffLink(prLink, path));
	}

	return formatCommentReference(formatGroupedPathLabel(paths), undefined);
}

function getDirectoryName(path: string): string {
	const lastSeparatorIndex = path.lastIndexOf("/");
	return lastSeparatorIndex >= 0 ? path.slice(0, lastSeparatorIndex) : "";
}

function getBaseName(path: string): string {
	const lastSeparatorIndex = path.lastIndexOf("/");
	return lastSeparatorIndex >= 0 ? path.slice(lastSeparatorIndex + 1) : path;
}

function formatGroupedPathLabel(paths: string[]): string {
	const firstDirectory = getDirectoryName(paths[0] ?? "");
	const hasSameDirectory = paths.every(
		(path) => getDirectoryName(path) === firstDirectory,
	);
	if (hasSameDirectory) {
		const names = paths.map((path) => getBaseName(path)).join(",");
		return firstDirectory ? `${firstDirectory}/{${names}}` : `{${names}}`;
	}

	return `{${paths.join(",")}}`;
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
	const prLabel = `#${context.pr.id} ${context.pr.title}`;
	const lines = [
		"### Review Scope",
		`- PR: ${formatCommentReference(prLabel, context.pr.link, false)}; branches: \`${context.pr.source.displayId}\` -> \`${context.pr.target.displayId}\`; diff: ${context.diffStats.fileCount} ${pluralize(context.diffStats.fileCount, "file")} (+${context.diffStats.additions}/-${context.diffStats.deletions}); reviewed: ${context.reviewedFiles.length}; skipped: ${context.skippedFiles.length}.`,
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
	const sanitizedOutcome = sanitizeReviewOutcomeForOutput(outcome);
	const findingSummary =
		sanitizedOutcome.findings.length > 0
			? `\n\nTaxonomy: ${buildFindingTypeSummary(sanitizedOutcome.findings) ?? "reportable findings"}\n\nTop validated findings:\n${buildFindingSummaryLines(sanitizedOutcome.findings).join("\n")}`
			: "";
	const details = truncateText(
		`${sanitizedOutcome.summary}\n\nAdvisory AI review generated by GitHub Copilot. Only validated findings on reviewable changed files and changed lines are published.${findingSummary}`,
		1900,
	);
	const result: InsightReportPayload["result"] =
		sanitizedOutcome.findings.length > 0 ? "FAIL" : "PASS";

	return omitUndefined({
		title: config.report.title,
		details,
		result,
		reporter: config.report.reporter,
		link: config.report.link,
		data: buildReportData(config, context, sanitizedOutcome),
	}) satisfies InsightReportPayload;
}

export function buildPullRequestComment(
	config: ReviewerConfig,
	context: ReviewContext,
	outcome: ReviewOutcome,
): string {
	const sanitizedOutcome = sanitizeReviewOutcomeForOutput(outcome);
	const header = buildPullRequestCommentTagMarker(config.report.commentTag);
	const metadataMarkers = buildPullRequestCommentMetadataMarkers({
		tag: config.report.commentTag,
		revision: context.reviewRevision,
		reviewedCommit: context.headCommit,
		publishedCommit: context.headCommit,
		...omitUndefined({
			findingsJson: buildStoredFindingMetadata(sanitizedOutcome.findings),
		}),
	});
	const title = `## ${config.report.title}`;
	const prIntent = buildPrIntentSection(context, sanitizedOutcome);
	const prSummary = buildPullRequestSummarySection(context);
	const leadingSections = [header, ...metadataMarkers, title, prIntent]
		.filter((section) => section && section.trim().length > 0)
		.map((section) => section.trim());

	const optionalSections: string[] = [];
	for (const [heading, lines, omittedLabel] of [
		[
			"### Findings",
			buildCommentFindingSummaryLines(
				context.pr.link,
				sanitizedOutcome.findings,
			),
			pluralize(sanitizedOutcome.findings.length, "finding"),
		],
		[
			"### File Changes",
			buildFileChangeSummaryLines(context, sanitizedOutcome),
			pluralize(context.reviewedFiles.length, "file summary", "file summaries"),
		],
	] as const) {
		const section = fitCommentSection({
			baseSections: [...leadingSections, ...optionalSections, prSummary],
			heading,
			...(heading === "### Findings"
				? {
						pinnedLines: buildCommentFindingHeaderLines(
							sanitizedOutcome.findings,
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

	const visibleSections = [...leadingSections, ...optionalSections, prSummary];
	const skippedFilesSection = fitCommentSection({
		baseSections: visibleSections,
		heading: "### Outside Review Scope",
		lines: buildSkippedFilesLines(context),
		omittedLabel: pluralize(
			context.skippedFiles.length,
			"skipped file",
			"skipped files",
		),
		maxChars: BITBUCKET_PR_COMMENT_MAX_CHARS,
	});

	return truncateText(
		[...visibleSections, skippedFilesSection]
			.filter((section) => section && section.trim().length > 0)
			.join(COMMENT_SECTION_SEPARATOR)
			.trim(),
		BITBUCKET_PR_COMMENT_MAX_CHARS,
		{ preserveMaxLength: true },
	);
}
