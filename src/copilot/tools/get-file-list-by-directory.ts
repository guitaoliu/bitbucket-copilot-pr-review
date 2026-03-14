import { defineTool } from "@github/copilot-sdk";

import { getRepoDirectoryAccessDecision } from "../../policy/path-access.ts";
import { makeDirectoryPreview, toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createGetFileListByDirectoryTool(
	toolContext: ReviewToolContext,
) {
	const { context, git } = toolContext;

	return defineTool("get_file_list_by_directory", {
		description:
			"List repo files under a safe directory at the head or base revision for architectural context.",
		parameters: {
			type: "object",
			properties: {
				directory: {
					type: "string",
					description:
						"Repo-relative directory path. Use '.' or omit for the repo root.",
				},
				version: {
					type: "string",
					enum: ["head", "base"],
					description: "Which revision to inspect.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 200,
					description: "Maximum number of paths to return.",
				},
			},
			required: ["version"],
		},
		handler: async (args: {
			directory?: string;
			version: "head" | "base";
			limit?: number;
		}) => {
			const decision = getRepoDirectoryAccessDecision(args.directory);
			if (!decision.include) {
				return toRejectedResult(
					`Directory access rejected: ${decision.reason}`,
				);
			}

			const commit =
				args.version === "head" ? context.headCommit : context.mergeBaseCommit;
			const files = await git.listFilesAtCommit(
				commit,
				decision.normalizedPath,
			);
			const limit = Math.min(200, Math.max(1, args.limit ?? 50));
			const preview = makeDirectoryPreview(files, limit);

			return {
				directory: decision.normalizedPath || ".",
				version: args.version,
				...preview,
			};
		},
	});
}
