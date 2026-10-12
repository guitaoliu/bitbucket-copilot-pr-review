import type { ReviewFinding } from "../policy/types.ts";
import { omitUndefined } from "../shared/object.ts";

/** `key:` is the current line-independent identity; `thread:` and `legacy:` come from earlier versions. */
export type FindingCommentKey =
	| `key:${string}`
	| `thread:${string}`
	| `legacy:${string}`;

export function isLegacyFindingCommentKey(key: FindingCommentKey): boolean {
	return !key.startsWith("key:");
}

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

export function formatFindingKeyMarker(
	tag: string,
	findingKey: string,
): string {
	return `<!-- ${tag}:finding-key:${findingKey} -->`;
}

export function formatFindingCodeMarker(tag: string, codeKey: string): string {
	return `<!-- ${tag}:finding-code:${codeKey} -->`;
}

export function isSummaryCommentText(tag: string, text: string): boolean {
	return text.includes(formatCommentTagMarker(tag));
}

export function parseSummaryCommentRevision(
	tag: string,
	text: string,
): string | undefined {
	return isSummaryCommentText(tag, text)
		? parseMarkerValue(tag, "revision", text)
		: undefined;
}

/**
 * Identity keys a finding comment may carry, newest marker format first:
 * `finding-key` (current), `finding-thread` and `finding` (earlier versions).
 */
export function findingCommentKeys(
	findingKey: string,
	finding: Pick<ReviewFinding, "threadKey" | "externalId">,
): FindingCommentKey[] {
	return [
		`key:${findingKey}`,
		`thread:${finding.threadKey}`,
		`legacy:${finding.externalId}`,
	];
}

export interface FindingCommentIdentity {
	key: FindingCommentKey;
	codeKey?: string;
}

export function parseFindingCommentIdentity(
	tag: string,
	text: string,
): FindingCommentIdentity | undefined {
	const findingKey = parseMarkerValue(tag, "finding-key", text);
	if (findingKey) {
		const codeKey = parseMarkerValue(tag, "finding-code", text);
		return omitUndefined({ key: `key:${findingKey}` as const, codeKey });
	}

	const threadKey = parseMarkerValue(tag, "finding-thread", text);
	if (threadKey) {
		return { key: `thread:${threadKey}` };
	}

	const legacyExternalId = parseMarkerValue(tag, "finding", text);
	return legacyExternalId ? { key: `legacy:${legacyExternalId}` } : undefined;
}
