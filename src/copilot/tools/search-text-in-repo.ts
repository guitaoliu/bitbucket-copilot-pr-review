import { defineTool } from "@github/copilot-sdk";
import { getRepoDirectoryAccessDecision } from "../../policy/path-access.ts";
import { omitUndefined } from "../../shared/object.ts";
import { toRejectedResult, validateSearchQuery } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createSearchTextInRepoTool(toolContext: ReviewToolContext) {
	const { context, git } = toolContext;

	return defineTool("search_text_in_repo", {
		description:
			"Search repo files at the head or base revision for literal or regex text matches within a safe directory.",
		parameters: {
			type: "object",
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
				directory: {
					type: "string",
					description: "Optional repo-relative directory restriction.",
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
			directory?: string;
			mode?: "literal" | "regex";
			wholeWord?: boolean;
			limit?: number;
		}) => {
			const query = validateSearchQuery(args.query, 200);
			if (!query) {
				return toRejectedResult(
					"Search query must be non-empty, single-line, and at most 200 characters.",
				);
			}

			const directoryDecision = getRepoDirectoryAccessDecision(args.directory);
			if (!directoryDecision.include) {
				return toRejectedResult(
					`Directory access rejected: ${directoryDecision.reason}`,
				);
			}

			const commit =
				args.version === "head" ? context.headCommit : context.mergeBaseCommit;
			const searchOptions = omitUndefined({
				directoryPath: directoryDecision.normalizedPath,
				limit: Math.min(200, Math.max(1, args.limit ?? 50)),
				mode: args.mode ?? "literal",
				wholeWord: args.mode === "regex" ? false : args.wholeWord,
			});
			const result = await git.searchTextAtCommit(commit, query, searchOptions);

			return {
				query,
				version: args.version,
				mode: args.mode ?? "literal",
				wholeWord: args.mode === "regex" ? false : Boolean(args.wholeWord),
				directory: directoryDecision.normalizedPath || ".",
				...result,
			};
		},
	});
}
