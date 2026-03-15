import { defineTool } from "@github/copilot-sdk";

import { omitUndefined } from "../../shared/object.ts";
import { summarizeFile } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createListChangedFilesTool(toolContext: ReviewToolContext) {
	const { context } = toolContext;

	return defineTool("list_changed_files", {
		description:
			"List the changed files available for review, with status and changed line ranges.",
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
		handler: async (args: { includeSkipped?: boolean }) =>
			omitUndefined({
				reviewedFiles: context.reviewedFiles.map((file) => summarizeFile(file)),
				skippedFiles: args.includeSkipped ? context.skippedFiles : undefined,
			}),
	});
}
