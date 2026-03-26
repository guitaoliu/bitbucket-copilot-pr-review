import { defineTool } from "@github/copilot-sdk";

import { omitUndefined } from "../../shared/object.ts";
import { summarizeFile } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createGetPrOverviewTool(toolContext: ReviewToolContext) {
	const { context } = toolContext;

	return defineTool("get_pr_overview", {
		description: "Get pull request metadata, diff statistics, and CI summary.",
		skipPermission: true,
		handler: async () =>
			omitUndefined({
				title: context.pr.title,
				description: context.pr.description,
				sourceBranch: context.pr.source.displayId,
				targetBranch: context.pr.target.displayId,
				headCommit: context.headCommit,
				mergeBaseCommit: context.mergeBaseCommit,
				diffStats: context.diffStats,
				reviewedFiles: context.reviewedFiles.map((file) => summarizeFile(file)),
				skippedFiles: context.skippedFiles,
				ciSummary: omitUndefined({
					status: context.ciSummary ? "ok" : "missing",
					content: context.ciSummary,
					message: context.ciSummary
						? undefined
						: "No CI summary was provided.",
				}),
			}),
	});
}
