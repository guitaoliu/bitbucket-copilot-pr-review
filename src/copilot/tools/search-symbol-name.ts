import { defineTool } from "@github/copilot-sdk";

import { buildSymbolSearchPattern } from "../../git/diff.ts";
import { getRepoDirectoryAccessDecision } from "../../policy/path-access.ts";
import { toRejectedResult, validateSearchQuery } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createSearchSymbolNameTool(toolContext: ReviewToolContext) {
	const { context, git } = toolContext;

	return defineTool("search_symbol_name", {
		description:
			"Search for a likely identifier or symbol name across repo files at the head or base revision.",
		parameters: {
			type: "object",
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
				directory: {
					type: "string",
					description: "Optional repo-relative directory restriction.",
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
			directory?: string;
			limit?: number;
		}) => {
			const symbol = validateSearchQuery(args.symbol, 120);
			if (!symbol) {
				return toRejectedResult(
					"Symbol query must be non-empty, single-line, and at most 120 characters.",
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
			const result = await git.searchTextAtCommit(
				commit,
				buildSymbolSearchPattern(symbol),
				{
					directoryPath: directoryDecision.normalizedPath,
					limit: Math.min(200, Math.max(1, args.limit ?? 50)),
					mode: "regex",
				},
			);

			return {
				symbol,
				version: args.version,
				directory: directoryDecision.normalizedPath || ".",
				...result,
			};
		},
	});
}
