import type { ReviewerConfig } from "../../config/types.ts";
import type { ChangedFile } from "../../git/types.ts";
import { formatLineRanges } from "../../policy/line-ranges.ts";
import { normalizeFindingDraftLocation } from "../../review/file.ts";
import type { FindingDraft } from "../../review/types.ts";
import { omitUndefined } from "../../shared/object.ts";
import { formatFileSlice } from "../../shared/text.ts";

export function summarizeFile(file: ChangedFile): Record<string, unknown> {
	return {
		path: file.path,
		oldPath: file.oldPath,
		status: file.status,
		additions: file.additions,
		deletions: file.deletions,
		changedLineCount: file.changedLines.length,
		changedLineRanges: formatLineRanges(file.changedLines),
		hunks: file.hunks.map((hunk) => ({
			newStart: hunk.newStart,
			newEnd: Math.max(
				hunk.newStart,
				hunk.newStart + Math.max(hunk.newLines, 1) - 1,
			),
			header: hunk.header,
		})),
	};
}

export function extractPatchHunk(
	file: ChangedFile,
	hunkIndex: number,
): { fileHeader?: string; hunkPatch: string } | undefined {
	const patchLines = file.patch.split(/\r?\n/);
	const hunkStarts = patchLines.flatMap((line, index) =>
		/^@@ -/.test(line) ? [index] : [],
	);
	if (hunkStarts.length === 0) {
		return undefined;
	}

	const selectedIndex = hunkIndex - 1;
	if (selectedIndex < 0 || selectedIndex >= hunkStarts.length) {
		return undefined;
	}

	const headerLines = patchLines.slice(0, hunkStarts[0]);
	const hunkStart = hunkStarts[selectedIndex] as number;
	const hunkEnd = hunkStarts[selectedIndex + 1] ?? patchLines.length;

	return omitUndefined({
		fileHeader:
			headerLines.length > 0 ? headerLines.join("\n").trimEnd() : undefined,
		hunkPatch: patchLines.slice(hunkStart, hunkEnd).join("\n").trimEnd(),
	});
}

export function makeDirectoryPreview(
	files: string[],
	maxEntries: number,
): { files: string[]; truncated: boolean; totalFiles: number } {
	return {
		files: files.slice(0, maxEntries),
		truncated: files.length > maxEntries,
		totalFiles: files.length,
	};
}

export function validateSearchQuery(
	query: string,
	maxLength: number,
): string | undefined {
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	if (trimmed.length > maxLength) {
		return undefined;
	}

	if (trimmed.includes("\u0000") || /[\r\n]/.test(trimmed)) {
		return undefined;
	}

	return trimmed;
}

export function validateFindingDraftLocation(
	draft: FindingDraft,
	reviewedFileMap: Map<string, ChangedFile>,
): { normalizedDraft?: FindingDraft; note?: string; error?: string } {
	const result = normalizeFindingDraftLocation(draft, reviewedFileMap);
	if (result.error) {
		return result;
	}

	const normalizedDraft = result.normalizedDraft;
	if (!normalizedDraft) {
		return {
			error: `The file ${draft.path} is not one of the reviewed files.`,
		};
	}

	const file = reviewedFileMap.get(normalizedDraft.path);
	if (!file) {
		return {
			error: `The file ${normalizedDraft.path} is not one of the reviewed files.`,
		};
	}

	if (
		normalizedDraft.line > 0 &&
		!file.changedLines.includes(normalizedDraft.line)
	) {
		return {
			error: `Line ${normalizedDraft.line} is not a changed line in ${normalizedDraft.path}. Valid changed line ranges: ${formatLineRanges(file.changedLines)}`,
		};
	}

	return result;
}

export function toRejectedResult(message: string) {
	return {
		textResultForLlm: message,
		resultType: "rejected" as const,
	};
}

export function buildFileSliceResult(
	content: string,
	filePath: string,
	version: "head" | "base",
	startLine: number | undefined,
	endLine: number | undefined,
	reviewConfig: ReviewerConfig["review"],
) {
	const totalLines = content.split(/\r?\n/).length;
	const requestedStart = Math.max(1, startLine ?? 1);
	const defaultEnd = requestedStart + reviewConfig.defaultFileSliceLines - 1;
	const requestedEnd = endLine ?? defaultEnd;
	const safeEnd = Math.min(
		totalLines,
		requestedEnd,
		requestedStart + reviewConfig.maxFileSliceLines - 1,
	);

	return omitUndefined({
		path: filePath,
		version,
		totalLines,
		returnedStartLine: requestedStart,
		returnedEndLine: safeEnd,
		content: formatFileSlice(content, requestedStart, safeEnd),
		note:
			safeEnd < totalLines
				? `Content truncated. Request lines ${safeEnd + 1}-${Math.min(totalLines, safeEnd + reviewConfig.defaultFileSliceLines)} if you need more.`
				: undefined,
	});
}
