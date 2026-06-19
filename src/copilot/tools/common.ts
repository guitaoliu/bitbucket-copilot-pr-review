import type { ChangedFile, FileStatus, SkippedFile } from "../../git/types.ts";
import { formatLineRanges } from "../../policy/line-ranges.ts";
import type { ChangedLineResolver } from "../../review/changed-lines.ts";
import { normalizeFindingDraftLocation } from "../../review/file.ts";
import type { FindingDraft } from "../../review/types.ts";
import { type OmitUndefined, omitUndefined } from "../../shared/object.ts";

export type ReviewedFileScope = OmitUndefined<{
	path: string;
	oldPath?: string;
	status: FileStatus;
	isBinary?: true;
}>;

export type SkippedFileScope = OmitUndefined<{
	path: string;
	oldPath?: string;
	status: FileStatus;
	reason: string;
}>;

export interface PrOverviewResult {
	reviewedFiles: ReviewedFileScope[];
	skippedFiles: SkippedFileScope[];
}

export function summarizeReviewedFileScope(
	file: ChangedFile,
): ReviewedFileScope {
	return omitUndefined({
		path: file.path,
		oldPath: file.oldPath,
		status: file.status,
		isBinary: file.isBinary ? true : undefined,
	});
}

export function summarizeSkippedFileScope(file: SkippedFile): SkippedFileScope {
	return omitUndefined({
		path: file.path,
		oldPath: file.oldPath,
		status: file.status,
		reason: file.reason,
	});
}

export async function validateFindingDraftLocation(
	draft: FindingDraft,
	reviewedFileMap: Map<string, ChangedFile>,
	resolveChangedLines: ChangedLineResolver,
): Promise<{ normalizedDraft?: FindingDraft; note?: string; error?: string }> {
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

	if (normalizedDraft.line > 0 && file.changedLines === undefined) {
		const { changedLines } = await resolveChangedLines(file);
		const remapped = normalizeFindingDraftLocation(
			normalizedDraft,
			reviewedFileMap,
		);
		if (remapped.error) {
			return {
				error: `Line ${normalizedDraft.line} is not a changed line in ${normalizedDraft.path}. Valid changed line ranges: ${formatLineRanges(changedLines)}`,
			};
		}

		const note = [result.note, remapped.note].filter(Boolean).join(" ");
		return omitUndefined({
			normalizedDraft: remapped.normalizedDraft ?? normalizedDraft,
			note: note.length > 0 ? note : undefined,
		});
	}

	return result;
}

export function toRejectedResult(message: string) {
	return {
		textResultForLlm: message,
		resultType: "rejected" as const,
	};
}
