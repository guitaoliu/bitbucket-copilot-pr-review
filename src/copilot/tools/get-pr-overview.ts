import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { omitUndefined } from "../../shared/object.ts";
import { truncatePullRequestDescription } from "../pr-description.ts";
import {
	buildReviewedFilePage,
	MAX_REVIEWED_FILES_PAGE_SIZE,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const getPrOverviewArgsSchema = z
	.object({
		reviewedFilesOffset: z.number().int().min(0).optional(),
		reviewedFilesLimit: z
			.number()
			.int()
			.min(1)
			.max(MAX_REVIEWED_FILES_PAGE_SIZE)
			.optional(),
	})
	.strict();

export function createGetPrOverviewTool(toolContext: ReviewToolContext) {
	const { context } = toolContext;

	return defineTool("get_pr_overview", {
		description:
			"Get pull request metadata, changed-file metadata, and CI summary. Use reviewedFilesOffset and reviewedFilesLimit to page through large reviews.",
		skipPermission: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				reviewedFilesOffset: {
					type: "integer",
					minimum: 0,
					description:
						"0-based index into the reviewed-file list. Use this to request the next changed-file batch in large reviews.",
				},
				reviewedFilesLimit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_REVIEWED_FILES_PAGE_SIZE,
					description:
						"Maximum number of reviewed files to return in this batch.",
				},
			},
		},
		handler: async (args: {
			reviewedFilesOffset?: number;
			reviewedFilesLimit?: number;
		}) => {
			const parsedArgs = getPrOverviewArgsSchema.safeParse(args);
			if (!parsedArgs.success) {
				return {
					resultType: "rejected" as const,
					textResultForLlm: `Invalid PR overview payload: ${parsedArgs.error.message}`,
				};
			}

			const description = truncatePullRequestDescription(
				context.pr.description,
			);
			const reviewedFilePage = buildReviewedFilePage(
				context.reviewedFiles,
				omitUndefined({
					offset: parsedArgs.data.reviewedFilesOffset,
					limit: parsedArgs.data.reviewedFilesLimit,
				}),
			);

			return omitUndefined({
				title: context.pr.title,
				description: description.content,
				descriptionTruncated: description.truncated,
				descriptionOriginalChars: description.originalChars,
				sourceBranch: context.pr.source.displayId,
				targetBranch: context.pr.target.displayId,
				headCommit: context.headCommit,
				mergeBaseCommit: context.mergeBaseCommit,
				diffStats: context.diffStats,
				...reviewedFilePage,
				skippedFiles: context.skippedFiles,
				ciSummary: omitUndefined({
					status: context.ciSummary ? "ok" : "missing",
					content: context.ciSummary,
					message: context.ciSummary
						? undefined
						: "No CI summary was provided.",
				}),
			});
		},
	});
}
