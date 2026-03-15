import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import type { GitTextSearchResult } from "../../git/search.ts";
import { getRepoDirectoriesAccessDecision } from "../../policy/path-access.ts";
import { omitUndefined } from "../../shared/object.ts";
import {
	describeDirectoryScope,
	filterSafeRepoPaths,
	toRejectedResult,
	validateDirectoryScopesAtCommit,
	validateSearchQuery,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const searchTextInRepoArgsSchema = z
	.object({
		query: z.string(),
		version: z.enum(["head", "base"]),
		directories: z.array(z.string()).max(50).optional(),
		mode: z.enum(["literal", "regex"]).optional(),
		wholeWord: z.boolean().optional(),
		limit: z.number().int().min(1).optional(),
	})
	.strict();

function validateRegexPattern(pattern: string): string | undefined {
	try {
		new RegExp(pattern, "u");
		return undefined;
	} catch (error) {
		return (error as Error).message;
	}
}

export function createSearchTextInRepoTool(toolContext: ReviewToolContext) {
	const { context, git } = toolContext;

	return defineTool("search_text_in_repo", {
		description:
			"Search repo files at the head or base revision for literal or regex text matches within safe directories.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: {
					type: "string",
					description: "Literal text or regex pattern to search for.",
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
				mode: {
					type: "string",
					enum: ["literal", "regex"],
					description: "Search mode.",
				},
				wholeWord: {
					type: "boolean",
					description: "Whole-word matching for literal search.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 200,
					description: "Maximum matches to return.",
				},
			},
			required: ["query", "version"],
		},
		handler: async (args: {
			query: string;
			version: "head" | "base";
			directories?: string[];
			mode?: "literal" | "regex";
			wholeWord?: boolean;
			limit?: number;
		}) => {
			const parsedArgs = searchTextInRepoArgsSchema.safeParse(args);
			if (!parsedArgs.success) {
				return toRejectedResult(
					`Invalid search payload: ${parsedArgs.error.message}`,
				);
			}

			const query = validateSearchQuery(parsedArgs.data.query, 200);
			if (!query) {
				return toRejectedResult(
					"Search query must be non-empty, single-line, and at most 200 characters.",
				);
			}

			const mode = parsedArgs.data.mode ?? "literal";
			if (mode === "regex") {
				const regexError = validateRegexPattern(query);
				if (regexError) {
					return toRejectedResult(
						`Invalid regex search pattern: ${regexError}`,
					);
				}
			}

			if (mode === "regex" && parsedArgs.data.wholeWord) {
				return toRejectedResult(
					"wholeWord is only supported for literal searches.",
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

			const searchOptions = omitUndefined({
				directoryPaths: directoryDecision.normalizedPaths,
				limit: Math.min(200, Math.max(1, parsedArgs.data.limit ?? 50)),
				mode,
				wholeWord: mode === "regex" ? false : parsedArgs.data.wholeWord,
			});
			let result: GitTextSearchResult;
			try {
				result = await git.searchTextAtCommit(commit, query, searchOptions);
			} catch (error) {
				return toRejectedResult(
					`Search execution failed: ${(error as Error).message}`,
				);
			}
			const filtered = filterSafeRepoPaths(result.matches);
			const limit = searchOptions.limit ?? 50;
			const safeMatches = filtered.entries.slice(0, limit);

			return {
				query,
				version: parsedArgs.data.version,
				mode,
				wholeWord:
					mode === "regex" ? false : Boolean(parsedArgs.data.wholeWord),
				directories: describeDirectoryScope(directoryDecision.normalizedPaths),
				matches: safeMatches,
				truncated:
					filtered.entries.length > safeMatches.length ||
					filtered.filteredCount > 0,
				totalMatches: filtered.entries.length,
				unfilteredMatchCount: result.totalMatches,
				filteredMatchCount: filtered.filteredCount,
			};
		},
	});
}
