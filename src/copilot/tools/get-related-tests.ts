import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import type { ChangedFile } from "../../git/types.ts";
import { getReviewedFilePathForVersion } from "../../review/file.ts";
import { omitUndefined } from "../../shared/object.ts";
import { truncateText } from "../../shared/text.ts";
import { toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const NOISE_PATH_TOKENS = new Set([
	"src",
	"main",
	"java",
	"kotlin",
	"scala",
	"groovy",
	"ts",
	"tsx",
	"js",
	"jsx",
	"test",
	"tests",
	"spec",
	"specs",
	"lib",
	"api",
	"com",
	"org",
	"net",
]);

const TEST_DIR_PATTERN = /(^|\/)(test|tests|__tests__)($|\/)/i;

const getRelatedTestsArgsSchema = z
	.object({
		path: z.string().min(1),
		version: z.enum(["head", "base"]).optional(),
		limit: z.number().int().min(1).max(100).optional(),
	})
	.strict();

function isLikelyTestPath(filePath: string): boolean {
	if (TEST_DIR_PATTERN.test(filePath)) {
		return true;
	}

	return (
		/\.(test|spec)\.[^/]+$/i.test(filePath) ||
		/(?:^|\/)[^/]+Tests?\.[^/]+$/i.test(filePath)
	);
}

function tokenizePath(filePath: string): string[] {
	const [pathWithoutExtension] = filePath.split(/\.[^/.]+$/);
	if (!pathWithoutExtension) {
		return [];
	}

	return pathWithoutExtension
		.split("/")
		.flatMap((segment) => segment.split(/[^A-Za-z0-9]+/))
		.flatMap((segment) => segment.split(/(?=[A-Z][a-z])/))
		.map((segment) => segment.trim().toLowerCase())
		.filter((segment) => segment.length >= 3)
		.filter((segment) => !NOISE_PATH_TOKENS.has(segment));
}

function getTokenScore(filePath: string, tokens: string[]): number {
	const lowerPath = filePath.toLowerCase();
	let tokenScore = 0;

	for (const token of tokens) {
		if (lowerPath.includes(token)) {
			tokenScore += token.length;
		}
	}

	return tokenScore;
}

function scoreCandidate(
	filePath: string,
	tokens: string[],
): {
	tokenScore: number;
	score: number;
} {
	const tokenScore = getTokenScore(filePath, tokens);
	let score = tokenScore;

	if (TEST_DIR_PATTERN.test(filePath)) {
		score += 5;
	}

	if (/\.(test|spec)\.[^/]+$/i.test(filePath)) {
		score += 4;
	}

	if (/(?:^|\/)[^/]+Tests?\.[^/]+$/i.test(filePath)) {
		score += 4;
	}

	return { tokenScore, score };
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths)];
}

function buildCandidateDirectories(
	file: ChangedFile,
	version: "head" | "base",
): string[] {
	const activePath = getReviewedFilePathForVersion(file, version);
	const segments = activePath.split("/");
	const directories: string[] = [];

	for (let index = segments.length - 1; index >= 1; index -= 1) {
		const directory = segments.slice(0, index).join("/");
		if (directory.length > 0) {
			directories.push(directory);
		}
	}

	const topLevel = segments[0];
	if (topLevel && topLevel !== "src") {
		directories.push(topLevel);
	}

	directories.push("test", "tests");
	return uniquePaths(directories);
}

export function createGetRelatedTestsTool(toolContext: ReviewToolContext) {
	const { context, git, reviewedFileMap } = toolContext;

	return defineTool("get_related_tests", {
		description:
			"Suggest likely nearby automated tests for a reviewed file by scanning concrete directories at head or base.",
		skipPermission: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: {
					type: "string",
					description: "Path of the reviewed file to find related tests for.",
				},
				version: {
					type: "string",
					enum: ["head", "base"],
					description: "Which revision to inspect for candidate tests.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 100,
					description: "Maximum candidate test files to return.",
				},
			},
			required: ["path"],
		},
		handler: async (args: {
			path: string;
			version?: "head" | "base";
			limit?: number;
		}) => {
			const parsedArgs = getRelatedTestsArgsSchema.safeParse(args);
			if (!parsedArgs.success) {
				return toRejectedResult(
					`Invalid related-tests payload: ${parsedArgs.error.message}`,
				);
			}

			const file = reviewedFileMap.get(parsedArgs.data.path);
			if (!file) {
				return toRejectedResult(
					`The file ${parsedArgs.data.path} is not available for review. Use list_changed_files first.`,
				);
			}

			const version = parsedArgs.data.version ?? "head";
			const commit =
				version === "head" ? context.headCommit : context.mergeBaseCommit;
			const directories = buildCandidateDirectories(file, version);
			const collected: string[] = [];

			for (const directory of directories) {
				const pathType = await git.getPathTypeAtCommit(commit, directory);
				if (pathType !== "directory") {
					continue;
				}

				const files = await git.listFilesAtCommit(commit, [directory]);
				for (const candidate of files) {
					if (isLikelyTestPath(candidate)) {
						collected.push(candidate);
					}
				}
			}

			const tokens = tokenizePath(getReviewedFilePathForVersion(file, version));
			const limit = parsedArgs.data.limit ?? 20;
			const rankedCandidates = uniquePaths(collected)
				.map((candidatePath) => ({
					path: candidatePath,
					...scoreCandidate(candidatePath, tokens),
				}))
				.filter(
					(candidate) =>
						candidate.score > 0 &&
						(tokens.length === 0 || candidate.tokenScore > 0),
				)
				.sort(
					(left, right) =>
						right.score - left.score || left.path.localeCompare(right.path),
				)
				.slice(0, limit);

			return omitUndefined({
				path: parsedArgs.data.path,
				version,
				directoriesSearched: directories,
				candidateCount: rankedCandidates.length,
				candidates: rankedCandidates.map((candidate) => ({
					path: candidate.path,
					score: candidate.score,
				})),
				note:
					rankedCandidates.length === 0
						? truncateText(
								"No likely related tests were found in nearby concrete directories. If coverage still matters, search more narrowly with search_text_in_repo or inspect known test roots.",
								240,
							)
						: undefined,
			});
		},
	});
}
