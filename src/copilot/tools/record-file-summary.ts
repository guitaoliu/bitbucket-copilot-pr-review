import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import {
	MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES,
	shouldCreatePerFileSummaries,
} from "../../review/summary.ts";
import { toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const recordFileSummarySchema = z.object({
	path: z.string().min(1),
	summary: z.string().min(1).max(500),
});

export function createRecordFileSummaryTool(toolContext: ReviewToolContext) {
	const { context, summaryDrafts, reviewedFileMap } = toolContext;

	return defineTool("record_file_summary", {
		description:
			"Record a concise summary of what changed in one reviewed file.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: {
					type: "string",
					description: "Reviewed file path in the current commit.",
				},
				summary: {
					type: "string",
					description:
						"One sentence describing the meaningful behavior or code change in this file.",
				},
			},
			required: ["path", "summary"],
		},
		handler: async (args: { path: string; summary: string }) => {
			if (!shouldCreatePerFileSummaries(context.reviewedFiles.length)) {
				return toRejectedResult(
					`Per-file summaries are disabled when reviewed files exceed ${MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES}.`,
				);
			}

			const parsed = recordFileSummarySchema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid file summary payload: ${parsed.error.message}`,
				);
			}

			const file = reviewedFileMap.get(parsed.data.path);
			if (!file) {
				return toRejectedResult(
					`The file ${parsed.data.path} is not one of the reviewed files.`,
				);
			}

			const existingIndex = summaryDrafts.fileSummaries.findIndex(
				(entry) => entry.path === file.path,
			);
			const nextEntry = { path: file.path, summary: parsed.data.summary };

			if (existingIndex >= 0) {
				summaryDrafts.fileSummaries[existingIndex] = nextEntry;
				return `Updated the summary for ${file.path}.`;
			}

			summaryDrafts.fileSummaries.push(nextEntry);
			return `Recorded the summary for ${file.path}.`;
		},
	});
}
