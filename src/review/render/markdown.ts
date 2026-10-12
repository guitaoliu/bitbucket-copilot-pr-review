import type { ReviewFinding } from "../../policy/types.ts";

const FINDING_TYPE_ORDER = ["BUG", "VULNERABILITY", "CODE_SMELL"] as const;

const FINDING_TYPE_LABELS: Record<
	ReviewFinding["type"],
	[singular: string, plural: string]
> = {
	BUG: ["bug", "bugs"],
	VULNERABILITY: ["vulnerability", "vulnerabilities"],
	CODE_SMELL: ["code smell", "code smells"],
};

export function pluralize(
	count: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return count === 1 ? singular : plural;
}

export function buildPullRequestDiffLink(
	prLink: string | undefined,
	filePath: string,
	line?: number,
): string | undefined {
	if (!prLink) {
		return undefined;
	}

	const anchor = encodeURIComponent(filePath).replace(/%20/g, "+");
	return `${prLink.replace(/\/$/, "")}/diff#${anchor}${line && line > 0 ? `?t=${line}` : ""}`;
}

function formatCodeSpan(label: string): string {
	const normalizedLabel = label.replace(/[\r\n]+/g, " ");
	const backtickRuns = normalizedLabel.match(/`+/g) ?? [];
	if (backtickRuns.length === 0) {
		return `\`${normalizedLabel}\``;
	}

	const fence = "`".repeat(
		Math.max(0, ...backtickRuns.map((run) => run.length)) + 1,
	);
	return `${fence} ${normalizedLabel} ${fence}`;
}

export function formatCommentReference(
	label: string,
	link: string | undefined,
	fallbackAsCode = true,
): string {
	if (!link) {
		return fallbackAsCode ? formatCodeSpan(label) : label;
	}

	const safeLabel = label
		.replace(/\\/g, "\\\\")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]");
	return `[${safeLabel}](${link})`;
}

export function formatFindingLocation(
	finding: Pick<ReviewFinding, "path" | "line">,
): string {
	return finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
}

export function formatFindingBadge(finding: ReviewFinding): string {
	return `Type: ${finding.type} | Severity: ${finding.severity} | Confidence: ${finding.confidence}`;
}

export function formatFindingListLines(
	findings: ReviewFinding[],
	formatLocation: (finding: ReviewFinding) => string,
): string[] {
	return findings.map(
		(finding, index) =>
			`${index + 1}. [${formatFindingBadge(finding)}] ${formatLocation(finding)} - ${finding.title}`,
	);
}

export function formatFindingTypeSummary(
	findings: ReviewFinding[],
): string | undefined {
	const parts = FINDING_TYPE_ORDER.flatMap((type) => {
		const count = findings.filter((finding) => finding.type === type).length;
		if (count === 0) {
			return [];
		}

		const [singular, plural] = FINDING_TYPE_LABELS[type];
		return `${count} ${pluralize(count, singular, plural)}`;
	});

	return parts.length > 0 ? parts.join(", ") : undefined;
}
