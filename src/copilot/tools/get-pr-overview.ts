import { defineTool } from "@github/copilot-sdk";
import { summarizeFile } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createGetPrOverviewTool(toolContext: ReviewToolContext) {
	const { context } = toolContext;

	return defineTool("get_pr_overview", {
		description: "Get pull request metadata, diff statistics, and CI summary.",
		handler: async () => ({
			title: context.pr.title,
			description: context.pr.description,
			sourceBranch: context.pr.source.displayId,
			targetBranch: context.pr.target.displayId,
			headCommit: context.headCommit,
			mergeBaseCommit: context.mergeBaseCommit,
			diffStats: context.diffStats,
			reviewedFiles: context.reviewedFiles.map((file) => summarizeFile(file)),
			skippedFiles: context.skippedFiles,
			ciSummary: context.ciSummary ?? "No CI summary was provided.",
		}),
	});
}
