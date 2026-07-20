import type { ChangedFile, HunkSummary } from "../git/types.ts";
import type { FindingDraft } from "./types.ts";

function getHunkNewEnd(
	hunk: Pick<HunkSummary, "newStart" | "newLines">,
): number {
	return Math.max(
		hunk.newStart,
		hunk.newStart + Math.max(hunk.newLines, 1) - 1,
	);
}

function findNearestChangedLineInContainingHunk(
	line: number,
	file: { hunks?: HunkSummary[] },
): number | undefined {
	let nearestLine: number | undefined;
	let nearestDistance = Number.POSITIVE_INFINITY;

	for (const hunk of file.hunks ?? []) {
		const hunkEnd = getHunkNewEnd(hunk);
		if (line < hunk.newStart || line > hunkEnd) {
			continue;
		}

		for (const changedLine of hunk.changedLines) {
			const distance = Math.abs(changedLine - line);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestLine = changedLine;
			}
		}
	}

	return nearestLine;
}

function canUseOldPathForReviewedFileLookup(
	file: Pick<ChangedFile, "status" | "oldPath">,
): file is Pick<ChangedFile, "status" | "oldPath"> & { oldPath: string } {
	return file.status === "renamed" && file.oldPath !== undefined;
}

export function createReviewableFileLookup(
	reviewableFiles: ChangedFile[],
): Map<string, ChangedFile> {
	const lookup = new Map<string, ChangedFile>();
	const oldPathCounts = new Map<string, number>();

	for (const file of reviewableFiles) {
		lookup.set(file.path, file);
		if (canUseOldPathForReviewedFileLookup(file)) {
			oldPathCounts.set(
				file.oldPath,
				(oldPathCounts.get(file.oldPath) ?? 0) + 1,
			);
		}
	}

	for (const file of reviewableFiles) {
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
	reviewableFileMap: Map<string, ChangedFile>,
): { normalizedDraft?: FindingDraft; note?: string; error?: string } {
	const file = reviewableFileMap.get(draft.path);
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
		file.changedLines !== undefined &&
		!file.changedLines.includes(normalizedDraft.line)
	) {
		const remappedLine = findNearestChangedLineInContainingHunk(
			normalizedDraft.line,
			{ hunks: file.hunks ?? [] },
		);
		if (remappedLine !== undefined) {
			normalizedDraft = {
				...normalizedDraft,
				line: remappedLine,
			};
			notes.push(`normalized line from ${draft.line} to ${remappedLine}`);
		} else {
			return {
				error: `Line ${normalizedDraft.line} is not a changed line in ${file.path}.`,
			};
		}
	}

	if (notes.length > 0) {
		return {
			normalizedDraft,
			note: `${notes.join("; ")}.`,
		};
	}

	return { normalizedDraft };
}
