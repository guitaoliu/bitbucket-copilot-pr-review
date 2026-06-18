import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const recordChangeAreaSummarySchema = z.object({
	title: z.string().min(1).max(80),
	paths: z.array(z.string().min(1)).min(1),
	summary: z.string().min(1).max(500),
});

export function createRecordChangeAreaSummaryTool(
	toolContext: ReviewToolContext,
) {
	const { reviewedFileMap, summaryDrafts } = toolContext;

	return defineTool("record_change_area_summary", {
		description:
			"Record one logical change area summary for reviewed files that belong together.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				title: {
					type: "string",
					description:
						"A short label for this logical change area, such as Authentication flow or Config schema.",
				},
				paths: {
					type: "array",
					items: { type: "string" },
					description:
						"Reviewed file paths that belong to this area. Use only paths from the reviewed scope.",
				},
				summary: {
					type: "string",
					description:
						"What this group of changed files does together. Skip this tool if the files do not form a clear logical area.",
				},
			},
			required: ["title", "paths", "summary"],
		},
		handler: async (args: {
			title: string;
			paths: string[];
			summary: string;
		}) => {
			const parsed = recordChangeAreaSummarySchema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid change area summary payload: ${parsed.error.message}`,
				);
			}

			const paths: string[] = [];
			const seenPaths = new Set<string>();
			for (const path of parsed.data.paths) {
				const file = reviewedFileMap.get(path);
				if (!file) {
					return toRejectedResult(
						`The file ${path} is not one of the reviewed files.`,
					);
				}

				if (!seenPaths.has(file.path)) {
					seenPaths.add(file.path);
					paths.push(file.path);
				}
			}

			summaryDrafts.changeAreas ??= [];
			summaryDrafts.changeAreas.push({
				title: parsed.data.title,
				paths,
				summary: parsed.data.summary,
			});
			return "Recorded the change area summary.";
		},
	});
}
