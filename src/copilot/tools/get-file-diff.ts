import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import {
	buildTruncatedPatchResult,
	parseObjectToolArgs,
	summarizeFile,
	toRejectedResult,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const getFileDiffArgsSchema = z
	.object({
		path: z.string().min(1),
	})
	.strict();

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
			const parsedArgs = parseObjectToolArgs(
				args,
				getFileDiffArgsSchema,
				"Invalid file-diff payload",
			);
			if (parsedArgs.rejection) {
				return parsedArgs.rejection;
			}
			const parsedData = parsedArgs.data;
			if (!parsedData) {
				return toRejectedResult("Invalid file-diff payload: expected an object payload.");
			}

			const file = reviewedFileMap.get(parsedData.path);
			if (!file) {
				return toRejectedResult(
					`The file ${parsedData.path} is not available for review. Use list_changed_files first.`,
				);
			}

			return {
				...summarizeFile(file),
				...buildTruncatedPatchResult(file.patch, config.review.maxPatchChars),
			};
		},
	});
}
