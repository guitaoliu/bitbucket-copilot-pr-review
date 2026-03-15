import type { ReviewerConfig } from "../../config/types.ts";
import type { GitRepository } from "../../git/repo.ts";
import type { ChangedFile } from "../../git/types.ts";
import { formatLineRanges } from "../../policy/line-ranges.ts";
import { getRepoFileAccessDecision } from "../../policy/path-access.ts";
import { normalizeFindingDraftLocation } from "../../review/file.ts";
import type { FindingDraft } from "../../review/types.ts";
import { omitUndefined } from "../../shared/object.ts";
import { formatFileSlice, truncateText } from "../../shared/text.ts";

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

export function describeDirectoryScope(directoryPaths: string[]): string[] {
	return directoryPaths.length > 0 ? directoryPaths : ["."];
}

export function filterSafeRepoPaths<T extends { path: string }>(
	entries: T[],
): {
	entries: T[];
	filteredCount: number;
} {
	const safeEntries: T[] = [];
	let filteredCount = 0;

	for (const entry of entries) {
		const decision = getRepoFileAccessDecision(entry.path);
		if (!decision.include) {
			filteredCount += 1;
			continue;
		}

		safeEntries.push(entry);
	}

	return { entries: safeEntries, filteredCount };
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

export function validateFileSliceRange(
	startLine: number | undefined,
	endLine: number | undefined,
): string | undefined {
	if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
		return `endLine (${endLine}) must be greater than or equal to startLine (${startLine}).`;
	}

	return undefined;
}

export async function validateDirectoryScopesAtCommit(
	git: GitRepository,
	commit: string,
	directories: string[],
): Promise<
	| { status: "ok" }
	| { status: "not_found"; path: string }
	| { status: "not_directory"; path: string }
> {
	for (const directory of directories) {
		const pathType = await git.getPathTypeAtCommit(commit, directory);
		if (!pathType) {
			return { status: "not_found", path: directory };
		}

		if (pathType !== "directory") {
			return { status: "not_directory", path: directory };
		}
	}

	return { status: "ok" };
}

export function buildMissingPathResult(
	path: string,
	version: "head" | "base",
	kind: "file" | "directory" = "file",
) {
	return {
		status: "not_found" as const,
		kind,
		path,
		version,
		message: `${kind === "directory" ? "Directory" : "File"} ${path} is not present in the ${version} revision.`,
	};
}

export function buildTextUnavailableResult(
	path: string,
	version: "head" | "base",
) {
	return {
		status: "unavailable" as const,
		path,
		version,
		message: `File ${path} could not be read as UTF-8 text from the ${version} revision.`,
	};
}

export function buildTruncatedPatchResult(patch: string, maxChars: number) {
	const truncated = patch.length > maxChars;
	const returnedPatch = truncateText(patch, maxChars, {
		suffix: "\n... truncated ...",
	});

	return {
		patch: returnedPatch,
		truncated,
		returnedPatchChars: returnedPatch.length,
	};
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
	if (requestedStart > totalLines) {
		return {
			status: "out_of_range" as const,
			path: filePath,
			version,
			totalLines,
			message: `Requested startLine ${requestedStart} is beyond the end of ${filePath} (${totalLines} lines).`,
		};
	}

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
