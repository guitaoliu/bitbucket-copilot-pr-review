import { parseUnifiedDiff } from "../git/diff.ts";
import type { GitRepository } from "../git/repo.ts";
import type { ChangedFile, HunkSummary } from "../git/types.ts";
import type { ReviewContext } from "./types.ts";

export type ChangedLineResolver = (
	file: ChangedFile,
) => Promise<{ changedLines: number[]; hunks: HunkSummary[] }>;

function findParsedFile(
	file: ChangedFile,
	parsedFiles: ChangedFile[],
): ChangedFile | undefined {
	return parsedFiles.find(
		(parsed) =>
			parsed.path === file.path ||
			(file.oldPath !== undefined && parsed.oldPath === file.oldPath),
	);
}

export function createChangedLineResolver(
	context: ReviewContext,
	git: GitRepository,
): ChangedLineResolver {
	const cache = new Map<
		string,
		Promise<{ changedLines: number[]; hunks: HunkSummary[] }>
	>();

	return async (file) => {
		const cached = cache.get(file.path);
		if (cached) {
			return cached;
		}

		const promise = git
			.diffFilePatch(context.mergeBaseCommit, context.headCommit, file.path)
			.then((patch) => {
				const parsedFile = findParsedFile(file, parseUnifiedDiff(patch).files);
				const changedLines = parsedFile?.changedLines ?? [];
				const hunks = parsedFile?.hunks ?? [];
				file.patch = patch;
				file.changedLines = changedLines;
				file.hunks = hunks;
				return { changedLines, hunks };
			});
		cache.set(file.path, promise);
		return promise;
	};
}
