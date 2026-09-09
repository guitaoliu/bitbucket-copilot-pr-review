import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { selectPage } from "../review-bundle.ts";
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
const pathsSchema = z.array(pathSchema).max(MAX_PATHS).default([]);
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
	recordInspectionResult(
		toolContext.inspectionState,
		toolName,
		JSON.stringify(result),
	);
}

export function createReadFileTool(toolContext: ReviewToolContext) {
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
			const page = selectPage(
				result.status === "ok"
					? formatRanges(result.content, parsed.data.ranges)
					: `[${result.status}]`,
				parsed.data.page,
			);
			const output = { ...page, path: parsed.data.path };
			recordResult(toolContext, "read_file", output);
			return output;
		},
	});
}

export function createSearchRepoTool(toolContext: ReviewToolContext) {
	const schema = z.object({
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
	});
	return defineTool("search_repo", {
		description:
			"Search repository text at a fixed review revision for 1 to 8 patterns. Returns matching lines with up to 12 lines of surrounding context. Start with page 1 and request later pages only when totalPages confirms they exist; use read_file for larger ranges.",
		parameters: schema,
		handler: async (args) => {
			const requestedContextLines = (args as { contextLines?: unknown } | null)
				?.contextLines;
			const parsed = schema.safeParse(
				typeof requestedContextLines === "number" &&
					Number.isInteger(requestedContextLines) &&
					requestedContextLines > MAX_SEARCH_CONTEXT_LINES
					? { ...args, contextLines: MAX_SEARCH_CONTEXT_LINES }
					: args,
			);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid repository search: ${parsed.error.message}`,
				);
			}
			toolContext.logger?.info(
				"Copilot repository search request",
				parsed.data,
			);
			const content = await toolContext.git.searchTextAtCommit(
				resolveRevision(parsed.data.revision, toolContext),
				parsed.data.patterns,
				parsed.data.patternType,
				parsed.data.paths,
				parsed.data.contextLines,
			);
			const output = selectPage(
				content || "No matches.",
				parsed.data.page,
				SEARCH_PAGE_CONTENT_BYTES,
			);
			recordResult(toolContext, "search_repo", output);
			return output;
		},
	});
}

export function createFindFilesTool(toolContext: ReviewToolContext) {
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
			const output = selectPage(
				content || "No matching files.",
				parsed.data.page,
			);
			recordResult(toolContext, "find_files", output);
			return output;
		},
	});
}
