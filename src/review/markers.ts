import type { PullRequestComment } from "../bitbucket/types.ts";
import type { ReviewFinding } from "../policy/types.ts";

function escapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMarkerValue(
	tag: string,
	name: string,
	text: string,
): string | undefined {
	const match = new RegExp(
		`<!--\\s*${escapeRegexLiteral(tag)}:${escapeRegexLiteral(name)}:([^>\\s]+)\\s*-->`,
	).exec(text);
	return match?.[1];
}

export function formatCommentTagMarker(tag: string): string {
	return `<!-- ${tag} -->`;
}

export function formatRevisionMarker(tag: string, revision: string): string {
	return `<!-- ${tag}:revision:${revision} -->`;
}

export function formatFindingThreadMarker(
	tag: string,
	threadKey: string,
): string {
	return `<!-- ${tag}:finding-thread:${threadKey} -->`;
}

export function findSummaryComments(
	tag: string,
	comments: PullRequestComment[],
): PullRequestComment[] {
	const marker = formatCommentTagMarker(tag);
	return comments.filter((comment) => comment.text.includes(marker));
}

export function parseSummaryCommentRevision(
	tag: string,
	text: string,
): string | undefined {
	return text.includes(formatCommentTagMarker(tag))
		? parseMarkerValue(tag, "revision", text)
		: undefined;
}

export function findingCommentKeys(
	finding: Pick<ReviewFinding, "threadKey" | "externalId">,
): string[] {
	return [`thread:${finding.threadKey}`, `legacy:${finding.externalId}`];
}

export function parseFindingCommentKey(
	tag: string,
	text: string,
): string | undefined {
	const threadKey = parseMarkerValue(tag, "finding-thread", text);
	if (threadKey) {
		return `thread:${threadKey}`;
	}

	const legacyExternalId = parseMarkerValue(tag, "finding", text);
	return legacyExternalId ? `legacy:${legacyExternalId}` : undefined;
}
