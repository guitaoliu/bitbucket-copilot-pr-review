import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import {
	buildTruncatedPatchResult,
	extractPatchHunk,
	parseObjectToolArgs,
	summarizeFile,
	toRejectedResult,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const getFileDiffHunkArgsSchema = z
	.object({
		path: z.string().min(1),
		hunkIndex: z.number().int().min(1),
	})
	.strict();

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
			const parsedArgs = parseObjectToolArgs(
				args,
				getFileDiffHunkArgsSchema,
				"Invalid file-diff-hunk payload",
			);
			if (parsedArgs.rejection) {
				return parsedArgs.rejection;
			}
			const parsedData = parsedArgs.data;
			if (!parsedData) {
				return toRejectedResult(
					"Invalid file-diff-hunk payload: expected an object payload.",
				);
			}

			const file = reviewedFileMap.get(parsedData.path);
			if (!file) {
				return toRejectedResult(
					`The file ${parsedData.path} is not available for review. Use list_changed_files first.`,
				);
			}

			const extracted = extractPatchHunk(file, parsedData.hunkIndex);
			if (!extracted) {
				const rangeDescription =
					file.hunks.length > 0 ? `1-${file.hunks.length}` : "none";
				return toRejectedResult(
					`Hunk ${parsedData.hunkIndex} is not available for ${parsedData.path}. Valid hunk indexes: ${rangeDescription}`,
				);
			}

			return {
				...summarizeFile(file),
				hunkIndex: parsedData.hunkIndex,
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
