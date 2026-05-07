import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import {
	type PrOverviewResult,
	summarizeReviewedFileScope,
	summarizeSkippedFileScope,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const getPrOverviewArgsSchema = z.object({}).strict();

function formatOverviewArgsError(error: z.ZodError): string {
	return error.issues.map((issue) => issue.message).join("; ");
}

export function createGetPrOverviewTool(toolContext: ReviewToolContext) {
	const { context } = toolContext;

	return defineTool("get_pr_overview", {
		description:
			"Get canonical review scope: reviewed files you may target and skipped files you must ignore. Use builtin bash for diff and code inspection.",
		skipPermission: true,
		handler: async (args: unknown) => {
			const parsedArgs = getPrOverviewArgsSchema.safeParse(args ?? {});
			if (!parsedArgs.success) {
				return {
					resultType: "rejected" as const,
					textResultForLlm: `Invalid PR overview payload: ${formatOverviewArgsError(parsedArgs.error)}`,
				};
			}

			return {
				reviewedFiles: context.reviewedFiles.map((file) =>
					summarizeReviewedFileScope(file),
				),
				skippedFiles: context.skippedFiles.map((file) =>
					summarizeSkippedFileScope(file),
				),
			} satisfies PrOverviewResult;
		},
	});
}
