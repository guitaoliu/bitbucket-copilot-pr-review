import { defineTool } from "@github/copilot-sdk";

import type { ReviewToolContext } from "./context.ts";

export function createGetCiSummaryTool(toolContext: ReviewToolContext) {
	const { context } = toolContext;

	return defineTool("get_ci_summary", {
		description:
			"Get the optional CI summary text produced earlier in the Jenkins pipeline.",
		handler: async () => context.ciSummary ?? "No CI summary was provided.",
	});
}
