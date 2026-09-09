import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const recordPrSummarySchema = z.object({
	summary: z.string().min(1).max(1000),
	reviewOutcome: z.enum(["clean", "findings_recorded"]),
});

export function createRecordPrSummaryTool(toolContext: ReviewToolContext) {
	const { summaryDrafts } = toolContext;

	return defineTool("record_pr_summary", {
		description:
			"Record a concise plain-language summary of what the pull request is trying to do.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				summary: {
					type: "string",
					minLength: 1,
					maxLength: 1000,
					description:
						"A concise summary of the PR's purpose and main behavior change. Use short bullet points when that is clearer than one sentence.",
				},
				reviewOutcome: {
					type: "string",
					enum: ["clean", "findings_recorded"],
					description:
						"Use clean only when no qualifying findings remain; otherwise use findings_recorded after emitting every qualifying finding.",
				},
			},
			required: ["summary", "reviewOutcome"],
		},
		handler: async (args: {
			summary: string;
			reviewOutcome: "clean" | "findings_recorded";
		}) => {
			const parsed = recordPrSummarySchema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid PR summary payload: ${parsed.error.message}`,
				);
			}
			const reviewBundle = toolContext.reviewBundle;
			if (reviewBundle && !reviewBundle.getCoverage().complete) {
				const missingPages = await reviewBundle.getMissingPages();
				const coverage = reviewBundle.getCoverage();
				const missing = missingPages ?? [];
				const preview = missing.slice(0, 20).join(", ");
				const remainder = Math.max(0, missing.length - 20);
				return toRejectedResult(
					`Review coverage is incomplete: ${coverage.deliveredPages}/${coverage.totalPages ?? "?"} pages delivered. Read missing review_changes pages: ${preview || "start with page 1"}${remainder > 0 ? ` (+${remainder} more)` : ""}.`,
				);
			}

			summaryDrafts.prSummary = parsed.data.summary;
			summaryDrafts.reviewOutcome = parsed.data.reviewOutcome;
			return "Recorded the pull request summary.";
		},
	});
}
