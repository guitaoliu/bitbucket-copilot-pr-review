import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { omitUndefined } from "../../shared/object.ts";
import { parseObjectToolArgs, summarizeFile, toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const listChangedFilesArgsSchema = z
	.object({
		includeSkipped: z.boolean().optional(),
	})
	.strict();

export function createListChangedFilesTool(toolContext: ReviewToolContext) {
	const { context } = toolContext;

	return defineTool("list_changed_files", {
		description:
			"List the changed files available for review, with status and changed line ranges.",
		skipPermission: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				includeSkipped: {
					type: "boolean",
					description:
						"Include skipped files and the reason they were skipped.",
				},
			},
		},
		handler: async (args: { includeSkipped?: boolean }) => {
			const parsedArgs = parseObjectToolArgs(
				args,
				listChangedFilesArgsSchema,
				"Invalid changed-files payload",
			);
			if (parsedArgs.rejection) {
				return parsedArgs.rejection;
			}
			const parsedData = parsedArgs.data;
			if (!parsedData) {
				return toRejectedResult(
					"Invalid changed-files payload: expected an object payload.",
				);
			}

			return omitUndefined({
				reviewedFiles: context.reviewedFiles.map((file) => summarizeFile(file)),
				skippedFiles: parsedData.includeSkipped
					? context.skippedFiles
					: undefined,
			});
		},
	});
}
