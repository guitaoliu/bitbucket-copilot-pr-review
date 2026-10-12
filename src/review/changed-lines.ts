import { parseUnifiedDiff } from "../git/diff.ts";
import type { GitRepository } from "../git/repo.ts";
import type { ChangedFile } from "../git/types.ts";
import type { FileLineChanges } from "../policy/findings.ts";
import type { ReviewContext } from "./types.ts";

export type ChangedLineResolver = (
	file: ChangedFile,
) => Promise<FileLineChanges>;

export function createChangedLineResolver(
	context: ReviewContext,
	git: GitRepository,
): ChangedLineResolver {
	const cache = new Map<string, Promise<FileLineChanges>>();

	return (file) => {
		if (file.changedLines !== undefined && file.hunks !== undefined) {
			return Promise.resolve({
				changedLines: file.changedLines,
				hunks: file.hunks,
			});
		}

		const cached = cache.get(file.path);
		if (cached) {
			return cached;
		}

		const pathspec =
			file.status === "renamed" && file.oldPath !== undefined
				? [file.oldPath, file.path]
				: file.path;
		const promise = git
			.diffFilePatch(context.mergeBaseCommit, context.headCommit, pathspec)
			.then((patch) => {
				const parsedFile = parseUnifiedDiff(patch).files.find(
					(parsed) =>
						parsed.path === file.path ||
						(file.oldPath !== undefined && parsed.oldPath === file.oldPath),
				);
				if (!parsedFile) {
					throw new Error(
						`Unable to resolve changed lines for ${file.path}: the diff between ${context.mergeBaseCommit} and ${context.headCommit} has no entry for it.`,
					);
				}
				return {
					changedLines: parsedFile.changedLines ?? [],
					hunks: parsedFile.hunks ?? [],
				};
			});
		cache.set(file.path, promise);
		return promise;
	};
}
