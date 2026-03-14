import { defineTool } from "@github/copilot-sdk";

import { getRepoFileAccessDecision } from "../../policy/path-access.ts";
import { buildFileSliceResult, toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createGetRelatedFileContentTool(
	toolContext: ReviewToolContext,
) {
	const { config, context, git } = toolContext;

	return defineTool("get_related_file_content", {
		description:
			"Read a safe repo-relative file outside the changed set for nearby architectural context.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Repo-relative file path at head or base.",
				},
				version: {
					type: "string",
					enum: ["head", "base"],
					description: "Which revision to read.",
				},
				startLine: {
					type: "integer",
					minimum: 1,
					description: "1-based start line.",
				},
				endLine: {
					type: "integer",
					minimum: 1,
					description: "1-based end line.",
				},
			},
			required: ["path", "version"],
		},
		handler: async (args: {
			path: string;
			version: "head" | "base";
			startLine?: number;
			endLine?: number;
		}) => {
			const decision = getRepoFileAccessDecision(args.path);
			if (!decision.include) {
				return toRejectedResult(
					`Related file access rejected: ${decision.reason}`,
				);
			}

			const commit =
				args.version === "head" ? context.headCommit : context.mergeBaseCommit;
			const content = await git.readFileAtCommit(
				commit,
				decision.normalizedPath,
			);
			if (content === undefined) {
				return `File ${decision.normalizedPath} is not present in the ${args.version} revision.`;
			}

			return buildFileSliceResult(
				content,
				decision.normalizedPath,
				args.version,
				args.startLine,
				args.endLine,
				config.review,
			);
		},
	});
}
