import path from "node:path";
import type { ChangedFile } from "../git/types.ts";
import { getRepoFileAccessDecision } from "./path-access.ts";

function isReviewablePath(filePath: string, ignorePaths: string[]): boolean {
	return (
		getRepoFileAccessDecision(filePath).include &&
		!ignorePaths.some((pattern) => path.posix.matchesGlob(filePath, pattern))
	);
}

export function filterChangedFiles(
	files: ChangedFile[],
	ignorePaths: string[],
): ChangedFile[] {
	return files.filter(
		(file) =>
			!file.isBinary &&
			isReviewablePath(file.path, ignorePaths) &&
			(file.oldPath === undefined ||
				isReviewablePath(file.oldPath, ignorePaths)),
	);
}
