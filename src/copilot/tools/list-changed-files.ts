import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { omitUndefined } from "../../shared/object.ts";
import {
	buildReviewedFilePage,
	DEFAULT_REVIEWED_FILES_PAGE_SIZE,
	MAX_REVIEWED_FILES_PAGE_SIZE,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const listChangedFilesArgsSchema = z
	.object({
		includeSkipped: z.boolean().optional(),
		offset: z.number().int().min(0).optional(),
		limit: z.number().int().min(1).max(MAX_REVIEWED_FILES_PAGE_SIZE).optional(),
	})
	.strict();

export function createListChangedFilesTool(toolContext: ReviewToolContext) {
	const { context } = toolContext;

	return defineTool("list_changed_files", {
		description:
			"List the changed files available for review, with status and changed line ranges. Use offset and limit to page through large reviews.",
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
				offset: {
					type: "integer",
					minimum: 0,
					description:
						"0-based index into the reviewed-file list. Use this to request the next batch in large reviews.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_REVIEWED_FILES_PAGE_SIZE,
					description:
						"Maximum number of reviewed files to return in this batch.",
				},
			},
		},
		handler: async (args: {
			includeSkipped?: boolean;
			offset?: number;
			limit?: number;
		}) => {
			const parsedArgs = listChangedFilesArgsSchema.safeParse(args);
			if (!parsedArgs.success) {
				return {
					resultType: "rejected" as const,
					textResultForLlm: `Invalid changed-file-list payload: ${parsedArgs.error.message}`,
				};
			}

			const reviewedFilePage = buildReviewedFilePage(context.reviewedFiles, {
				...omitUndefined({
					offset: parsedArgs.data.offset,
					limit: parsedArgs.data.limit ?? DEFAULT_REVIEWED_FILES_PAGE_SIZE,
				}),
			});

			return omitUndefined({
				...reviewedFilePage,
				skippedFiles: parsedArgs.data.includeSkipped
					? context.skippedFiles
					: undefined,
			});
		},
	});
}
