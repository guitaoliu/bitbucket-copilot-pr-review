import { defineTool } from "@github/copilot-sdk";

import { getReviewedFilePathForVersion } from "../../review/file.ts";
import { buildFileSliceResult, toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createGetFileContentTool(toolContext: ReviewToolContext) {
	const { config, context, git, reviewedFileMap } = toolContext;

	return defineTool("get_file_content", {
		description:
			"Get head or base file contents with line numbers for a reviewed file.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path of the reviewed file." },
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
			const file = reviewedFileMap.get(args.path);
			if (!file) {
				return toRejectedResult(
					`The file ${args.path} is not available for review. Use list_changed_files first.`,
				);
			}

			const commit =
				args.version === "head" ? context.headCommit : context.mergeBaseCommit;
			const filePath = getReviewedFilePathForVersion(file, args.version);
			const content = await git.readFileAtCommit(commit, filePath);
			if (content === undefined) {
				return `File ${filePath} is not present in the ${args.version} revision.`;
			}

			return buildFileSliceResult(
				content,
				filePath,
				args.version,
				args.startLine,
				args.endLine,
				config.review,
			);
		},
	});
}
