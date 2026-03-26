import { defineTool } from "@github/copilot-sdk";

import {
	buildTruncatedPatchResult,
	extractPatchHunk,
	summarizeFile,
	toRejectedResult,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createGetFileDiffHunkTool(toolContext: ReviewToolContext) {
	const { config, reviewedFileMap } = toolContext;

	return defineTool("get_file_diff_hunk", {
		description:
			"Get a specific diff hunk for a reviewed file, including file header context.",
		skipPermission: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string", description: "Path of the reviewed file." },
				hunkIndex: {
					type: "integer",
					minimum: 1,
					description: "1-based diff hunk index to return.",
				},
			},
			required: ["path", "hunkIndex"],
		},
		handler: async (args: { path: string; hunkIndex: number }) => {
			const file = reviewedFileMap.get(args.path);
			if (!file) {
				return toRejectedResult(
					`The file ${args.path} is not available for review. Use list_changed_files first.`,
				);
			}

			const extracted = extractPatchHunk(file, args.hunkIndex);
			if (!extracted) {
				const rangeDescription =
					file.hunks.length > 0 ? `1-${file.hunks.length}` : "none";
				return toRejectedResult(
					`Hunk ${args.hunkIndex} is not available for ${args.path}. Valid hunk indexes: ${rangeDescription}`,
				);
			}

			return {
				...summarizeFile(file),
				hunkIndex: args.hunkIndex,
				totalHunks: file.hunks.length,
				fileHeader: extracted.fileHeader,
				...buildTruncatedPatchResult(
					extracted.hunkPatch,
					config.review.maxPatchChars,
				),
			};
		},
	});
}
