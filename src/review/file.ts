import type { ChangedFile } from "../git/types.ts";
import type { FindingDraft } from "./types.ts";

function canUseOldPathForReviewedFileLookup(
	file: Pick<ChangedFile, "status" | "oldPath">,
): file is Pick<ChangedFile, "status" | "oldPath"> & { oldPath: string } {
	return file.status === "renamed" && file.oldPath !== undefined;
}

export function getReviewedFilePathForVersion(
	file: Pick<ChangedFile, "path" | "oldPath" | "status">,
	version: "head" | "base",
): string {
	if (version === "head") {
		return file.path;
	}

	return canUseOldPathForReviewedFileLookup(file) ? file.oldPath : file.path;
}

export function createReviewedFileLookup(
	reviewedFiles: ChangedFile[],
): Map<string, ChangedFile> {
	const lookup = new Map<string, ChangedFile>();
	const oldPathCounts = new Map<string, number>();

	for (const file of reviewedFiles) {
		lookup.set(file.path, file);
		if (canUseOldPathForReviewedFileLookup(file)) {
			oldPathCounts.set(
				file.oldPath,
				(oldPathCounts.get(file.oldPath) ?? 0) + 1,
			);
		}
	}

	for (const file of reviewedFiles) {
		if (
			canUseOldPathForReviewedFileLookup(file) &&
			oldPathCounts.get(file.oldPath) === 1
		) {
			lookup.set(file.oldPath, file);
		}
	}

	return lookup;
}

export function normalizeFindingDraftLocation(
	draft: FindingDraft,
	reviewedFileMap: Map<string, ChangedFile>,
): { normalizedDraft?: FindingDraft; note?: string; error?: string } {
	const file = reviewedFileMap.get(draft.path);
	if (!file) {
		return {
			error: `The file ${draft.path} is not one of the reviewed files.`,
		};
	}

	const notes: string[] = [];
	let normalizedDraft: FindingDraft = draft;

	if (draft.path !== file.path) {
		normalizedDraft = {
			...normalizedDraft,
			path: file.path,
		};
		notes.push(`normalized path from ${draft.path} to ${file.path}`);
	}

	if (
		normalizedDraft.line > 0 &&
		!file.changedLines.includes(normalizedDraft.line)
	) {
		const requestedLine = normalizedDraft.line;
		normalizedDraft = {
			...normalizedDraft,
			line: 0,
		};
		notes.push(
			`requested line ${requestedLine} is not a changed line in ${file.path}; stored as a file-level annotation`,
		);
	}

	if (notes.length > 0) {
		return {
			normalizedDraft,
			note: `${notes.join("; ")}.`,
		};
	}

	return { normalizedDraft };
}
