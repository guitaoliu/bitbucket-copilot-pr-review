import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { GitInvalidSearchPatternError } from "../../git/repo.ts";
import { type PagedContent, selectPage } from "../review-bundle.ts";
import { toRejectedResult } from "./common.ts";
import { type ReviewToolContext, recordInspectionResult } from "./context.ts";

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
	.refine(isSafeRepoPath, "must be a relative repository path");
const pathsSchema = z
	.array(pathSchema)
	.max(MAX_PATHS)
	.default([])
	.describe(
		"Repository paths to search, or an empty array for the whole repository.",
	);
const rangeSchema = z
	.object({
		start: z.number().int().min(1),
		end: z.number().int().min(1),
	})
	.refine(({ start, end }) => end >= start, "end must be >= start");

function isSafeRepoPath(value: string): boolean {
	const containsControlCharacter = [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
	return (
		!value.startsWith("/") &&
		!value.startsWith(":") &&
		!/^[A-Za-z]:/.test(value) &&
		!value.includes("\\") &&
		!containsControlCharacter &&
		!value.split("/").includes("..")
	);
}

function resolveRevision(
	revision: "merge-base" | "base" | "head",
	toolContext: ReviewToolContext,
): string {
	switch (revision) {
		case "merge-base":
			return toolContext.context.mergeBaseCommit;
		case "base":
			return toolContext.context.baseCommit;
		case "head":
			return toolContext.context.headCommit;
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

function recordResult(
	toolContext: ReviewToolContext,
	toolName: "read_file" | "search_repo" | "find_files",
	result: unknown,
): void {
	if (result && typeof result === "object") {
		const page = result as Partial<PagedContent>;
		if (page.paginationReset || page.outOfRange) {
			toolContext.logger?.warn("Recovered invalid context pagination", {
				toolName,
				requestedPage: page.requestedPage ?? page.page,
				returnedPage: page.outOfRange ? undefined : page.page,
				totalPages: page.totalPages,
			});
		}
	}
	recordInspectionResult(
		toolContext.inspectionState,
		toolName,
		JSON.stringify(result),
	);
}

function selectQueryPage(
	content: string,
	requestedPage: number,
	queryKey: string,
	deliveredPagesByQuery: Map<string, Set<number>>,
	maxBytes?: number,
): PagedContent {
	const deliveredPages =
		deliveredPagesByQuery.get(queryKey) ?? new Set<number>();
	const requested = selectPage(content, requestedPage, maxBytes);
	const firstMissingPage = Array.from(
		{ length: Math.min(requestedPage - 1, requested.totalPages) },
		(_value, index) => index + 1,
	).find((page) => !deliveredPages.has(page));
	const result =
		firstMissingPage === undefined
			? requested
			: {
					...selectPage(content, firstMissingPage, maxBytes),
					requestedPage,
					paginationReset: true as const,
				};
	if (!result.outOfRange) {
		deliveredPages.add(result.page);
		deliveredPagesByQuery.set(queryKey, deliveredPages);
	}
	return result;
}

function summarizeSearchMatches(content: string): {
	matchingLineCount: number;
	matchedFileCount: number;
} {
	const matchedFiles = new Set<string>();
	let matchingLineCount = 0;
	for (const line of content.split("\n")) {
		const match = line.match(/^[^:]+:(.+):\d+:/);
		if (!match?.[1]) {
			continue;
		}
		matchingLineCount += 1;
		matchedFiles.add(match[1]);
	}
	return { matchingLineCount, matchedFileCount: matchedFiles.size };
}

export function createReadFileTool(toolContext: ReviewToolContext) {
	const deliveredPagesByQuery = new Map<string, Set<number>>();
	const schema = z.object({
		revision: revisionSchema,
		path: pathSchema,
		ranges: z.array(rangeSchema).max(MAX_RANGES).optional(),
		page: pageSchema,
	});
	return defineTool("read_file", {
		description:
			"Read one text file at a fixed review revision. Use ranges for source lines and page for large results.",
		parameters: schema,
		overridesBuiltInTool: true,
		handler: async (args) => {
			const parsed = schema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(`Invalid file read: ${parsed.error.message}`);
			}
			const result = await toolContext.git.readTextFileAtCommit(
				resolveRevision(parsed.data.revision, toolContext),
				parsed.data.path,
			);
			const page = selectQueryPage(
				result.status === "ok"
					? formatRanges(result.content, parsed.data.ranges)
					: `[${result.status}]`,
				parsed.data.page,
				JSON.stringify({ ...parsed.data, page: undefined }),
				deliveredPagesByQuery,
			);
			const output = { ...page, path: parsed.data.path };
			recordResult(toolContext, "read_file", output);
			return output;
		},
	});
}

export function createSearchRepoTool(toolContext: ReviewToolContext) {
	const deliveredPagesByQuery = new Map<string, Set<number>>();
	const uniqueQueryKeys = new Set<string>();
	const noMatchQueryKeys = new Set<string>();
	const schema = z.preprocess(
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
		z.object({
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
	);
	return defineTool("search_repo", {
		description:
			"Search repository text at a fixed review revision for 1 to 8 patterns. Returns matching lines with up to 12 lines of surrounding context. Start with page 1 and continue only with nextPage from that exact query; use read_file for larger ranges.",
		parameters: schema,
		handler: async (args) => {
			const parsed = schema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid repository search: ${parsed.error.message}`,
				);
			}
			toolContext.logger?.info(
				"Copilot repository search request",
				parsed.data,
			);
			let content: string;
			try {
				content = await toolContext.git.searchTextAtCommit(
					resolveRevision(parsed.data.revision, toolContext),
					parsed.data.patterns,
					parsed.data.patternType,
					parsed.data.paths,
					parsed.data.contextLines,
				);
			} catch (error) {
				if (error instanceof GitInvalidSearchPatternError) {
					return toRejectedResult(
						"Invalid repository search regex. Use a valid extended regular expression or retry with patternType literal.",
					);
				}
				throw error;
			}
			const queryKey = JSON.stringify({ ...parsed.data, page: undefined });
			toolContext.inspectionState.searchRepoMetrics ??= {
				uniqueQueries: 0,
				duplicateQueries: 0,
				wholeRepoQueries: 0,
				noMatchQueries: 0,
			};
			const metrics = toolContext.inspectionState.searchRepoMetrics;
			if (deliveredPagesByQuery.get(queryKey)?.has(parsed.data.page)) {
				metrics.duplicateQueries += 1;
			}
			if (!uniqueQueryKeys.has(queryKey)) {
				uniqueQueryKeys.add(queryKey);
				metrics.uniqueQueries += 1;
				if (parsed.data.paths.length === 0) {
					metrics.wholeRepoQueries += 1;
				}
			}
			if (!content && !noMatchQueryKeys.has(queryKey)) {
				noMatchQueryKeys.add(queryKey);
				metrics.noMatchQueries += 1;
			}
			const scope =
				parsed.data.paths.length === 0
					? "entire repository"
					: `${parsed.data.paths.length} pathspec${parsed.data.paths.length === 1 ? "" : "s"}`;
			const matchSummary = summarizeSearchMatches(content);
			const patternLabel = `${parsed.data.patterns.length} ${parsed.data.patternType} pattern${parsed.data.patterns.length === 1 ? "" : "s"}`;
			const output = {
				...selectQueryPage(
					content ||
						`No matches at ${parsed.data.revision} across ${scope} for ${patternLabel}.`,
					parsed.data.page,
					queryKey,
					deliveredPagesByQuery,
					SEARCH_PAGE_CONTENT_BYTES,
				),
				searchedRevision: parsed.data.revision,
				searchScope: scope,
				patternType: parsed.data.patternType,
				patternCount: parsed.data.patterns.length,
				...matchSummary,
			};
			recordResult(toolContext, "search_repo", output);
			return output;
		},
	});
}

export function createFindFilesTool(toolContext: ReviewToolContext) {
	const deliveredPagesByQuery = new Map<string, Set<number>>();
	const schema = z.object({
		revision: revisionSchema,
		paths: pathsSchema,
		page: pageSchema,
	});
	return defineTool("find_files", {
		description:
			"List tracked repository files at a fixed review revision using exact paths, directory prefixes, or glob patterns.",
		parameters: schema,
		handler: async (args) => {
			const parsed = schema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid file listing: ${parsed.error.message}`,
				);
			}
			const content = await toolContext.git.listFilesAtCommit(
				resolveRevision(parsed.data.revision, toolContext),
				parsed.data.paths,
			);
			const output = selectQueryPage(
				content || "No matching files.",
				parsed.data.page,
				JSON.stringify({ ...parsed.data, page: undefined }),
				deliveredPagesByQuery,
			);
			recordResult(toolContext, "find_files", output);
			return output;
		},
	});
}
