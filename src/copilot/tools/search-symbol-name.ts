import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { buildSymbolSearchPattern } from "../../git/diff.ts";
import type { GitTextSearchResult } from "../../git/search.ts";
import { getRepoDirectoriesAccessDecision } from "../../policy/path-access.ts";
import {
	describeDirectoryScope,
	filterSafeRepoPaths,
	toRejectedResult,
	validateDirectoryScopesAtCommit,
	validateSearchQuery,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const searchSymbolNameArgsSchema = z
	.object({
		symbol: z.string(),
		version: z.enum(["head", "base"]),
		directories: z.array(z.string()).max(50).optional(),
		limit: z.number().int().min(1).optional(),
	})
	.strict();

export function createSearchSymbolNameTool(toolContext: ReviewToolContext) {
	const { context, git } = toolContext;

	return defineTool("search_symbol_name", {
		description:
			"Search for a likely identifier or symbol name across repo files at the head or base revision.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				symbol: {
					type: "string",
					description: "Identifier or symbol name to search for.",
				},
				version: {
					type: "string",
					enum: ["head", "base"],
					description: "Which revision to search.",
				},
				directories: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional repo-relative directories to search. Omit or use ['.'] for the repo root.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 200,
					description: "Maximum matches to return.",
				},
			},
			required: ["symbol", "version"],
		},
		handler: async (args: {
			symbol: string;
			version: "head" | "base";
			directories?: string[];
			limit?: number;
		}) => {
			const parsedArgs = searchSymbolNameArgsSchema.safeParse(args);
			if (!parsedArgs.success) {
				return toRejectedResult(
					`Invalid symbol-search payload: ${parsedArgs.error.message}`,
				);
			}

			const symbol = validateSearchQuery(parsedArgs.data.symbol, 120);
			if (!symbol) {
				return toRejectedResult(
					"Symbol query must be non-empty, single-line, and at most 120 characters.",
				);
			}

			const directoryDecision = getRepoDirectoriesAccessDecision(
				parsedArgs.data.directories,
			);
			if (!directoryDecision.include) {
				return toRejectedResult(
					`Directory access rejected: ${directoryDecision.reason}`,
				);
			}

			const commit =
				parsedArgs.data.version === "head"
					? context.headCommit
					: context.mergeBaseCommit;
			const directoryValidation = await validateDirectoryScopesAtCommit(
				git,
				commit,
				directoryDecision.normalizedPaths,
			);
			if (directoryValidation.status === "not_found") {
				return toRejectedResult(
					`Directory access rejected: ${directoryValidation.path} is not present in the ${parsedArgs.data.version} revision.`,
				);
			}

			if (directoryValidation.status === "not_directory") {
				return toRejectedResult(
					`Directory access rejected: ${directoryValidation.path} is a file, not a directory.`,
				);
			}

			let result: GitTextSearchResult;
			try {
				result = await git.searchTextAtCommit(
					commit,
					buildSymbolSearchPattern(symbol),
					{
						directoryPaths: directoryDecision.normalizedPaths,
						limit: Math.min(200, Math.max(1, parsedArgs.data.limit ?? 50)),
						mode: "regex",
					},
				);
			} catch (error) {
				return toRejectedResult(
					`Symbol search execution failed: ${(error as Error).message}`,
				);
			}
			const filtered = filterSafeRepoPaths(result.matches);
			const limit = Math.min(200, Math.max(1, parsedArgs.data.limit ?? 50));
			const safeMatches = filtered.entries.slice(0, limit);
			const safeTotalMatches = result.truncated
				? Math.max(
						filtered.entries.length,
						result.totalMatches - filtered.filteredCount,
					)
				: filtered.entries.length;

			return {
				symbol,
				version: parsedArgs.data.version,
				directories: describeDirectoryScope(directoryDecision.normalizedPaths),
				matches: safeMatches,
				truncated:
					result.truncated ||
					filtered.entries.length > safeMatches.length ||
					filtered.filteredCount > 0,
				totalMatches: filtered.entries.length,
				unfilteredMatchCount: result.totalMatches,
				filteredMatchCount: filtered.filteredCount,
				safeTotalMatches,
			};
		},
	});
}
