import { z } from "zod";

import {
	GitInvalidSearchPatternError,
	type GitSearchFileMatches,
} from "../../git/repo.ts";
import {
	getRepoFileAccessDecision,
	matchesRepoPathPattern,
	normalizeRepoPath,
	REPO_SEARCH_EXCLUDE_GLOBS,
} from "../../policy/path-access.ts";
import {
	type PagedContent,
	paginateContent,
	selectPage,
} from "../pagination.ts";
import { type ReviewToolContext, recordInspectionResult } from "./context.ts";
import { defineReviewTool, rejectToolCall } from "./define.ts";

type ContextToolName = "read_file" | "search_repo" | "find_files";

const MAX_PATHS = 50;
const MAX_RANGES = 20;
const MAX_SEARCH_PATTERNS = 8;
const MAX_SEARCH_CONTEXT_LINES = 12;
const SEARCH_PAGE_CONTENT_BYTES = 16_000;
const revisionSchema = z.enum(["merge-base", "base", "head"]);
const pageSchema = z.number().int().min(1).default(1);
const pathSchema = z
	.string()
	.min(1)
	.max(500)
	.refine(
		(value) => normalizeRepoPath(value) !== undefined,
		"must be a relative repository path",
	);
const pathsSchema = z
	.array(pathSchema)
	.max(MAX_PATHS)
	.default([])
	.describe(
		"Repository paths to search, or an empty array for the whole repository.",
	);
const rangeSchema = z
	.strictObject({
		start: z.number().int().min(1),
		end: z.number().int().min(1),
	})
	.refine(({ start, end }) => end >= start, "end must be >= start");

function resolveRevision(
	revision: z.output<typeof revisionSchema>,
	{ context }: ReviewToolContext,
): string {
	switch (revision) {
		case "merge-base":
			return context.mergeBaseCommit;
		case "base":
			return context.baseCommit;
		case "head":
			return context.headCommit;
	}
}

function formatRanges(
	content: string,
	ranges?: Array<{ start: number; end: number }>,
): string {
	const lines = content.split(/\r?\n/);
	return (ranges ?? [{ start: 1, end: lines.length }])
		.map(({ start, end }) =>
			lines
				.slice(start - 1, Math.min(end, lines.length))
				.map((line, index) => `${start + index}\t${line}`)
				.join("\n"),
		)
		.filter(Boolean)
		.join("\n");
}

function formatSearchMatches(
	commit: string,
	files: GitSearchFileMatches[],
): string {
	return files
		.flatMap((file) =>
			file.groups.map((group) =>
				group
					.map((line) => {
						const separator = line.isMatch ? ":" : "-";
						return `${commit}:${file.path}${separator}${line.lineNumber}${separator}${line.text}\n`;
					})
					.join(""),
			),
		)
		.join("--\n");
}

function summarizeSearchMatches(files: GitSearchFileMatches[]): {
	matchingLineCount: number;
	matchedFileCount: number;
} {
	let matchingLineCount = 0;
	let matchedFileCount = 0;
	for (const file of files) {
		const fileMatches = file.groups
			.flat()
			.filter((line) => line.isMatch).length;
		matchingLineCount += fileMatches;
		matchedFileCount += fileMatches > 0 ? 1 : 0;
	}
	return { matchingLineCount, matchedFileCount };
}

function createQueryPager(
	toolContext: ReviewToolContext,
	toolName: ContextToolName,
	maxBytes?: number,
) {
	const deliveredPagesByQuery = new Map<string, Set<number>>();
	return {
		hasDelivered(queryKey: string, page: number): boolean {
			return deliveredPagesByQuery.get(queryKey)?.has(page) ?? false;
		},
		select(content: string, requestedPage: number, queryKey: string) {
			const pages = paginateContent(content, maxBytes);
			const deliveredPages =
				deliveredPagesByQuery.get(queryKey) ?? new Set<number>();
			const firstMissingPage = Array.from(
				{ length: Math.min(requestedPage - 1, pages.length) },
				(_value, index) => index + 1,
			).find((page) => !deliveredPages.has(page));
			const result: PagedContent =
				firstMissingPage === undefined
					? selectPage(pages, requestedPage)
					: {
							...selectPage(pages, firstMissingPage),
							requestedPage,
							paginationReset: true,
						};
			if (!result.outOfRange) {
				deliveredPages.add(result.page);
				deliveredPagesByQuery.set(queryKey, deliveredPages);
			}
			if (result.paginationReset || result.outOfRange) {
				toolContext.logger.warn("Recovered invalid context pagination", {
					toolName,
					requestedPage: result.requestedPage ?? result.page,
					returnedPage: result.outOfRange ? undefined : result.page,
					totalPages: result.totalPages,
				});
			}
			return result;
		},
	};
}

function recordContextResult<TResult extends PagedContent>(
	toolContext: ReviewToolContext,
	toolName: ContextToolName,
	result: TResult,
): TResult {
	recordInspectionResult(
		toolContext.state.inspection,
		toolName,
		JSON.stringify(result),
	);
	return result;
}

export function createReadFileTool(toolContext: ReviewToolContext) {
	const pager = createQueryPager(toolContext, "read_file");
	return defineReviewTool("read_file", {
		description:
			"Read one text file at a fixed review revision. Use ranges for source lines and page for large results.",
		schema: z.strictObject({
			revision: revisionSchema,
			path: pathSchema,
			ranges: z.array(rangeSchema).max(MAX_RANGES).optional(),
			page: pageSchema,
		}),
		overridesBuiltInTool: true,
		handler: async (args, invocation) => {
			const access = getRepoFileAccessDecision(args.path);
			if (!access.include) {
				return rejectToolCall(
					`Reading ${args.path} is not allowed: ${access.reason}.`,
				);
			}
			const result = await toolContext.git.readTextFileAtCommit(
				resolveRevision(args.revision, toolContext),
				access.normalizedPath,
				invocation.signal,
			);
			const page = pager.select(
				result.status === "ok"
					? formatRanges(result.content, args.ranges)
					: `[${result.status}]`,
				args.page,
				JSON.stringify({ ...args, page: undefined }),
			);
			return recordContextResult(toolContext, "read_file", {
				...page,
				path: args.path,
			});
		},
	});
}

export function createSearchRepoTool(toolContext: ReviewToolContext) {
	const pager = createQueryPager(
		toolContext,
		"search_repo",
		SEARCH_PAGE_CONTENT_BYTES,
	);
	const uniqueQueryKeys = new Set<string>();
	const noMatchQueryKeys = new Set<string>();
	const metrics = toolContext.state.inspection.searchRepoMetrics;
	return defineReviewTool("search_repo", {
		description:
			"Search repository text at a fixed review revision for 1 to 8 patterns. Returns matching lines with up to 12 lines of surrounding context. Start with page 1 and continue only with nextPage from that exact query; use read_file for larger ranges.",
		schema: z.preprocess(
			(args) => {
				if (typeof args !== "object" || args === null) {
					return args;
				}
				const rawArgs = args as Record<string, unknown>;
				const requestedContextLines = rawArgs.contextLines;
				return {
					...rawArgs,
					...(Array.isArray(rawArgs.paths)
						? { paths: rawArgs.paths.filter((path) => path !== "") }
						: {}),
					...(typeof requestedContextLines === "number" &&
					Number.isInteger(requestedContextLines) &&
					requestedContextLines > MAX_SEARCH_CONTEXT_LINES
						? { contextLines: MAX_SEARCH_CONTEXT_LINES }
						: {}),
				};
			},
			z.strictObject({
				revision: revisionSchema,
				patterns: z
					.array(z.string().min(1).max(500))
					.min(1)
					.max(MAX_SEARCH_PATTERNS),
				patternType: z.enum(["literal", "regex"]).default("literal"),
				paths: pathsSchema,
				contextLines: z
					.number()
					.int()
					.min(0)
					.max(MAX_SEARCH_CONTEXT_LINES)
					.default(0),
				page: pageSchema,
			}),
		),
		handler: async (args, invocation) => {
			toolContext.logger.info("Copilot repository search request", args);
			const commit = resolveRevision(args.revision, toolContext);
			let files: GitSearchFileMatches[];
			try {
				files = (
					await toolContext.git.searchTextAtCommit({
						commit,
						patterns: args.patterns,
						patternType: args.patternType,
						paths: args.paths,
						excludeGlobs: REPO_SEARCH_EXCLUDE_GLOBS,
						contextLines: args.contextLines,
						signal: invocation.signal,
					})
				).filter((file) => getRepoFileAccessDecision(file.path).include);
			} catch (error) {
				if (error instanceof GitInvalidSearchPatternError) {
					return rejectToolCall(
						"Invalid repository search regex. Use a valid extended regular expression or retry with patternType literal.",
					);
				}
				throw error;
			}
			const content = formatSearchMatches(commit, files);
			const queryKey = JSON.stringify({ ...args, page: undefined });
			if (pager.hasDelivered(queryKey, args.page)) {
				metrics.duplicateQueries += 1;
			}
			if (!uniqueQueryKeys.has(queryKey)) {
				uniqueQueryKeys.add(queryKey);
				metrics.uniqueQueries += 1;
				if (args.paths.length === 0) {
					metrics.wholeRepoQueries += 1;
				}
			}
			if (!content && !noMatchQueryKeys.has(queryKey)) {
				noMatchQueryKeys.add(queryKey);
				metrics.noMatchQueries += 1;
			}
			const scope =
				args.paths.length === 0
					? "entire repository"
					: `${args.paths.length} pathspec${args.paths.length === 1 ? "" : "s"}`;
			const patternLabel = `${args.patterns.length} ${args.patternType} pattern${args.patterns.length === 1 ? "" : "s"}`;
			return recordContextResult(toolContext, "search_repo", {
				...pager.select(
					content ||
						`No matches at ${args.revision} across ${scope} for ${patternLabel}.`,
					args.page,
					queryKey,
				),
				searchedRevision: args.revision,
				searchScope: scope,
				patternType: args.patternType,
				patternCount: args.patterns.length,
				...summarizeSearchMatches(files),
			});
		},
	});
}

export function createFindFilesTool(toolContext: ReviewToolContext) {
	const pager = createQueryPager(toolContext, "find_files");
	return defineReviewTool("find_files", {
		description:
			"List tracked repository files at a fixed review revision using exact paths, directory prefixes, or glob patterns.",
		schema: z.strictObject({
			revision: revisionSchema,
			paths: pathsSchema,
			page: pageSchema,
		}),
		handler: async (args, invocation) => {
			const files = (
				await toolContext.git.listFilesAtCommit(
					resolveRevision(args.revision, toolContext),
					invocation.signal,
				)
			).filter(
				(filePath) =>
					(args.paths.length === 0 ||
						args.paths.some((pattern) =>
							matchesRepoPathPattern(filePath, pattern),
						)) &&
					getRepoFileAccessDecision(filePath).include,
			);
			return recordContextResult(
				toolContext,
				"find_files",
				pager.select(
					files.join("\n") || "No matching files.",
					args.page,
					JSON.stringify({ ...args, page: undefined }),
				),
			);
		},
	});
}
