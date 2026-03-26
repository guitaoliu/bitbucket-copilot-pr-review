import { defineTool } from "@github/copilot-sdk";

import { omitUndefined } from "../../shared/object.ts";

import type { ReviewToolContext } from "./context.ts";

export function createGetCiSummaryTool(toolContext: ReviewToolContext) {
	const { context } = toolContext;

	return defineTool("get_ci_summary", {
		description:
			"Get the optional CI summary text produced earlier in the current run.",
		skipPermission: true,
		handler: async () =>
			omitUndefined({
				status: context.ciSummary ? "ok" : "missing",
				ciSummary: context.ciSummary,
				message: context.ciSummary ? undefined : "No CI summary was provided.",
			}),
	});
}
