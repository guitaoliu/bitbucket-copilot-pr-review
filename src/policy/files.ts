import path from "node:path";
import type { ChangedFile, SkippedFile } from "../git/types.ts";
import { omitUndefined } from "../shared/object.ts";
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

export function shouldReviewFile(
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

	if (file.patch.trim().length === 0) {
		return { include: false, reason: "empty textual diff" };
	}

	return { include: true };
}

export function filterChangedFiles(
	files: ChangedFile[],
	maxFiles: number,
	ignorePaths: string[] = [],
): { reviewedFiles: ChangedFile[]; skippedFiles: SkippedFile[] } {
	const reviewedFiles: ChangedFile[] = [];
	const skippedFiles: SkippedFile[] = [];

	for (const file of files) {
		const decision = shouldReviewFile(file, ignorePaths);
		if (!decision.include) {
			skippedFiles.push(
				omitUndefined({
					path: file.path,
					oldPath: file.oldPath,
					status: file.status,
					reason: decision.reason || "excluded by review policy",
				}) satisfies SkippedFile,
			);
			continue;
		}

		reviewedFiles.push(file);
	}

	if (reviewedFiles.length <= maxFiles) {
		return { reviewedFiles, skippedFiles };
	}

	return {
		reviewedFiles: reviewedFiles.slice(0, maxFiles),
		skippedFiles: skippedFiles.concat(
			reviewedFiles.slice(maxFiles).map(
				(file) =>
					omitUndefined({
						path: file.path,
						oldPath: file.oldPath,
						status: file.status,
						reason: `exceeds REVIEW_MAX_FILES limit (${maxFiles})`,
					}) satisfies SkippedFile,
			),
		),
	};
}
