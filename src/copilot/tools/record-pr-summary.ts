import { z } from "zod";

import type { ReviewToolContext } from "./context.ts";
import { defineReviewTool, rejectToolCall } from "./define.ts";

export function createRecordPrSummaryTool(toolContext: ReviewToolContext) {
	const { reviewBundle, state } = toolContext;

	return defineReviewTool("record_pr_summary", {
		description:
			"Record a concise plain-language summary of what the pull request is trying to do.",
		schema: z.strictObject({
			summary: z
				.string()
				.min(1)
				.max(1000)
				.describe(
					"A concise summary of the PR's purpose and main behavior change. Use short bullet points when that is clearer than one sentence.",
				),
		}),
		handler: async ({ summary }) => {
			if (!reviewBundle.getCoverage().complete) {
				const missing = await reviewBundle.getMissingPages();
				const coverage = reviewBundle.getCoverage();
				const preview = missing.slice(0, 20).join(", ");
				const remainder = Math.max(0, missing.length - 20);
				return rejectToolCall(
					`Review coverage is incomplete: ${coverage.deliveredPages}/${coverage.totalPages ?? "?"} pages delivered. Read missing review_changes pages: ${preview || "start with page 1"}${remainder > 0 ? ` (+${remainder} more)` : ""}.`,
				);
			}

			state.summaryDrafts.prSummary = summary;
			return "Recorded the pull request summary.";
		},
	});
}
