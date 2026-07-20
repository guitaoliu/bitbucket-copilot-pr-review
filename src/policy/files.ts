import path from "node:path";
import type { ChangedFile } from "../git/types.ts";
import { getRepoFileAccessDecision } from "./path-access.ts";

function matchesIgnoredPath(
	filePath: string,
	ignorePaths: string[],
): string | undefined {
	const normalizedPath = filePath.replace(/\\/g, "/");
	return ignorePaths.find((pattern) =>
		path.posix.matchesGlob(normalizedPath, pattern),
	);
}

function getReviewablePathDecision(
	filePath: string,
	ignorePaths: string[],
	label?: string,
): { include: true } | { include: false; reason: string } {
	const pathDecision = getRepoFileAccessDecision(filePath);
	if (!pathDecision.include) {
		return {
			include: false,
			reason: label
				? `${label} rejected: ${pathDecision.reason}`
				: pathDecision.reason,
		};
	}

	const ignoredPattern = matchesIgnoredPath(filePath, ignorePaths);
	if (ignoredPattern) {
		return {
			include: false,
			reason: label
				? `${label} rejected: ignored path pattern (${ignoredPattern})`
				: `ignored path pattern (${ignoredPattern})`,
		};
	}

	return { include: true };
}

function shouldReviewFile(
	file: ChangedFile,
	ignorePaths: string[] = [],
): { include: boolean; reason?: string } {
	if (file.status === "deleted") {
		return { include: false, reason: "deleted file" };
	}

	if (file.isBinary) {
		return { include: false, reason: "binary diff" };
	}

	const pathDecision = getReviewablePathDecision(file.path, ignorePaths);
	if (!pathDecision.include) {
		return { include: false, reason: pathDecision.reason };
	}

	if (file.oldPath) {
		const oldPathDecision = getReviewablePathDecision(
			file.oldPath,
			ignorePaths,
			"source path",
		);
		if (!oldPathDecision.include) {
			return { include: false, reason: oldPathDecision.reason };
		}
	}

	return { include: true };
}

export function filterChangedFiles(
	files: ChangedFile[],
	ignorePaths: string[] = [],
): ChangedFile[] {
	return files.filter((file) => shouldReviewFile(file, ignorePaths).include);
}
