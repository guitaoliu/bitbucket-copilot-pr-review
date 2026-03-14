import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const recordPrSummarySchema = z.object({
	summary: z.string().min(1).max(1000),
});

export function createRecordPrSummaryTool(toolContext: ReviewToolContext) {
	const { summaryDrafts } = toolContext;

	return defineTool("record_pr_summary", {
		description:
			"Record a concise plain-language summary of what the pull request is trying to do.",
		parameters: {
			type: "object",
			properties: {
				summary: {
					type: "string",
					description:
						"One or two sentences describing the PR's purpose and main behavior change.",
				},
			},
			required: ["summary"],
		},
		handler: async (args: { summary: string }) => {
			const parsed = recordPrSummarySchema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid PR summary payload: ${parsed.error.message}`,
				);
			}

			summaryDrafts.prSummary = parsed.data.summary;
			return "Recorded the pull request summary.";
		},
	});
}
