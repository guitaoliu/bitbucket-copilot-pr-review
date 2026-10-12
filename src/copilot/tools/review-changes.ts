import { z } from "zod";

import { type ReviewToolContext, recordInspectionResult } from "./context.ts";
import { defineReviewTool } from "./define.ts";

export function createReviewChangesTool(toolContext: ReviewToolContext) {
	return defineReviewTool("review_changes", {
		description:
			"Read a deterministic page of trusted guidance, skill metadata, and the complete reviewable diff. Read page 1 first, then every remaining page before recording the PR summary.",
		schema: z.strictObject({
			page: z.number().int().min(1).default(1),
		}),
		handler: async ({ page }) => {
			const result = await toolContext.reviewBundle.getPage(page);
			recordInspectionResult(
				toolContext.state.inspection,
				"review_changes",
				JSON.stringify(result),
			);
			return result;
		},
	});
}
