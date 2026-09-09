import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { toRejectedResult } from "./common.ts";
import { type ReviewToolContext, recordInspectionResult } from "./context.ts";

const reviewChangesSchema = z.object({
	page: z.number().int().min(1).default(1),
});

export function createReviewChangesTool(toolContext: ReviewToolContext) {
	return defineTool("review_changes", {
		description:
			"Read a deterministic page of trusted guidance, skill metadata, and the complete reviewable diff. Read page 1 first, then every remaining page before recording the PR summary.",
		parameters: reviewChangesSchema,
		handler: async (args) => {
			const parsed = reviewChangesSchema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid review page request: ${parsed.error.message}`,
				);
			}
			const reviewBundle = toolContext.reviewBundle;
			if (!reviewBundle) {
				throw new Error("Review bundle is unavailable.");
			}
			const result = await reviewBundle.getPage(parsed.data.page);
			recordInspectionResult(
				toolContext.inspectionState,
				"review_changes",
				JSON.stringify(result),
			);
			return result;
		},
	});
}
