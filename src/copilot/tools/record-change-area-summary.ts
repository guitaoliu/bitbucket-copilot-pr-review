import { matchesGlob } from "node:path";
import { z } from "zod";

import type { ReviewToolContext } from "./context.ts";
import { defineReviewTool, rejectToolCall } from "./define.ts";

function resolveReviewedPathReference(
	pathExpression: string,
	{ context, reviewedFiles }: ReviewToolContext,
): string | undefined {
	const file = reviewedFiles.get(pathExpression);
	if (file) {
		return file.path;
	}

	const matchesReviewedFile = context.reviewableFiles.some(
		(candidate) =>
			matchesGlob(candidate.path, pathExpression) ||
			(candidate.oldPath !== undefined &&
				reviewedFiles.get(candidate.oldPath) === candidate &&
				matchesGlob(candidate.oldPath, pathExpression)),
	);
	return matchesReviewedFile ? pathExpression : undefined;
}

export function createRecordChangeAreaSummaryTool(
	toolContext: ReviewToolContext,
) {
	const { summaryDrafts } = toolContext.state;

	return defineReviewTool("record_change_area_summary", {
		description:
			"Record one logical change area summary for reviewed files that belong together.",
		schema: z.strictObject({
			title: z
				.string()
				.min(1)
				.max(80)
				.describe(
					"A short label for this logical change area, such as Authentication flow or Config schema.",
				),
			paths: z
				.array(z.string().min(1))
				.min(1)
				.describe(
					"Exact reviewed file paths or path globs that belong to this area. Patterns are validated only within the reviewed scope.",
				),
			summary: z
				.string()
				.min(1)
				.max(500)
				.describe(
					"What this group of changed files does together. Skip this tool if the files do not form a clear logical area.",
				),
		}),
		handler: async ({ title, paths, summary }) => {
			const references = new Set<string>();
			for (const pathExpression of paths) {
				const reference = resolveReviewedPathReference(
					pathExpression,
					toolContext,
				);
				if (reference === undefined) {
					return rejectToolCall(
						`The path ${pathExpression} does not match any reviewed file.`,
					);
				}
				references.add(reference);
			}

			summaryDrafts.changeAreas ??= [];
			summaryDrafts.changeAreas.push({
				title,
				paths: [...references],
				summary,
			});
			return "Recorded the change area summary.";
		},
	});
}
