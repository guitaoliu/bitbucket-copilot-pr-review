import { createHash } from "node:crypto";

import type { ReviewableFile } from "../git/types.ts";
import type { AnnotationType, FindingDraft } from "./types.ts";

const FILE_LEVEL_CODE = "<file>";

function shortDigest(parts: readonly string[]): string {
	return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Legacy line-number-based thread key, kept to match comments published by earlier versions. */
export function buildFindingThreadKey(input: {
	path: string;
	line: number;
	type: AnnotationType;
	collisionIndex?: number;
}): string {
	const collisionIndex = input.collisionIndex ?? 0;
	return `thread-${shortDigest([
		input.path,
		String(input.line),
		input.type,
		...(collisionIndex > 0 ? [String(collisionIndex)] : []),
	])}`;
}

function buildCodeKey(path: string, code: string): string {
	return shortDigest([path, code]);
}

export interface FindingCodeIdentity {
	/** Identifies the finding independently of its line number. */
	findingKey: string;
	/** Identifies the flagged code, so a stale finding can tell whether that code still exists. */
	codeKey: string;
}

/**
 * Keys each finding by its path, type, and the normalized text of the flagged
 * changed line (or a file-level token). Findings sharing those components are
 * numbered in line order, which edits elsewhere in the file cannot reorder.
 */
export function buildFindingIdentities<
	T extends Pick<FindingDraft, "path" | "line" | "type">,
>(
	findings: readonly T[],
	reviewableFiles: readonly ReviewableFile[],
): Array<FindingCodeIdentity & { finding: T }> {
	const filesByPath = new Map(reviewableFiles.map((file) => [file.path, file]));
	const entries = findings.map((finding, index) => {
		const code =
			finding.line > 0
				? normalizeCodeLine(
						filesByPath.get(finding.path)?.changedLineText.get(finding.line) ??
							"",
					)
				: FILE_LEVEL_CODE;
		return {
			finding,
			index,
			code,
			baseKey: JSON.stringify([finding.path, finding.type, code]),
		};
	});

	const occurrenceByIndex = new Map<number, number>();
	const countsByBaseKey = new Map<string, number>();
	const inLineOrder = [...entries].sort(
		(left, right) =>
			left.finding.line - right.finding.line || left.index - right.index,
	);
	for (const entry of inLineOrder) {
		const occurrence = countsByBaseKey.get(entry.baseKey) ?? 0;
		countsByBaseKey.set(entry.baseKey, occurrence + 1);
		occurrenceByIndex.set(entry.index, occurrence);
	}

	return entries.map(({ finding, index, code }) => ({
		finding,
		findingKey: shortDigest([
			finding.path,
			finding.type,
			code,
			String(occurrenceByIndex.get(index) ?? 0),
		]),
		codeKey: buildCodeKey(finding.path, code),
	}));
}

/** Code keys for every changed line and file-level location in the current review scope. */
export function collectCurrentCodeKeys(
	reviewableFiles: readonly ReviewableFile[],
): ReadonlySet<string> {
	const codeKeys = new Set<string>();
	for (const file of reviewableFiles) {
		codeKeys.add(buildCodeKey(file.path, FILE_LEVEL_CODE));
		for (const text of file.changedLineText.values()) {
			codeKeys.add(buildCodeKey(file.path, normalizeCodeLine(text)));
		}
	}
	return codeKeys;
}

function normalizeCodeLine(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}
