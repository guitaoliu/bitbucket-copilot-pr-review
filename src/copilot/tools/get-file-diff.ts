import { defineTool } from "@github/copilot-sdk";

import {
	buildTruncatedPatchResult,
	summarizeFile,
	toRejectedResult,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createGetFileDiffTool(toolContext: ReviewToolContext) {
	const { config, reviewedFileMap } = toolContext;

	return defineTool("get_file_diff", {
		description: "Get the unified diff for a specific reviewed file.",
		skipPermission: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string", description: "Path of the reviewed file." },
			},
			required: ["path"],
		},
		handler: async (args: { path: string }) => {
			const file = reviewedFileMap.get(args.path);
			if (!file) {
				return toRejectedResult(
					`The file ${args.path} is not available for review. Use list_changed_files first.`,
				);
			}

			return {
				...summarizeFile(file),
				...buildTruncatedPatchResult(file.patch, config.review.maxPatchChars),
			};
		},
	});
}
