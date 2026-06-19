import { matchesGlob } from "node:path";
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { ChangedFile } from "../../git/types.ts";
import { toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const recordChangeAreaSummarySchema = z.object({
	title: z.string().min(1).max(80),
	paths: z.array(z.string().min(1)).min(1),
	summary: z.string().min(1).max(500),
});

function hasPathGlob(value: string): boolean {
	return /[*?[\]{}()!+@]/.test(value);
}

function matchesReviewedPath(
	file: ChangedFile,
	pathExpression: string,
	reviewedFileMap: Map<string, ChangedFile>,
): boolean {
	return (
		matchesGlob(file.path, pathExpression) ||
		(file.oldPath !== undefined &&
			reviewedFileMap.get(file.oldPath) === file &&
			matchesGlob(file.oldPath, pathExpression))
	);
}

function resolveReviewedPathReference(
	pathExpression: string,
	toolContext: ReviewToolContext,
): { reference: string } | { error: string } {
	const file = toolContext.reviewedFileMap.get(pathExpression);
	if (file) {
		return { reference: file.path };
	}

	if (!hasPathGlob(pathExpression)) {
		return {
			error: `The file ${pathExpression} is not one of the reviewed files.`,
		};
	}

	const files = toolContext.context.reviewedFiles.filter((file) =>
		matchesReviewedPath(file, pathExpression, toolContext.reviewedFileMap),
	);
	return files.length > 0
		? { reference: pathExpression }
		: {
				error: `The path pattern ${pathExpression} did not match any reviewed files.`,
			};
}

export function createRecordChangeAreaSummaryTool(
	toolContext: ReviewToolContext,
) {
	const { summaryDrafts } = toolContext;

	return defineTool("record_change_area_summary", {
		description:
			"Record one logical change area summary for reviewed files that belong together.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				title: {
					type: "string",
					description:
						"A short label for this logical change area, such as Authentication flow or Config schema.",
				},
				paths: {
					type: "array",
					items: { type: "string" },
					description:
						"Exact reviewed file paths or path globs that belong to this area. Patterns are validated only within the reviewed scope.",
				},
				summary: {
					type: "string",
					description:
						"What this group of changed files does together. Skip this tool if the files do not form a clear logical area.",
				},
			},
			required: ["title", "paths", "summary"],
		},
		handler: async (args: {
			title: string;
			paths: string[];
			summary: string;
		}) => {
			const parsed = recordChangeAreaSummarySchema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid change area summary payload: ${parsed.error.message}`,
				);
			}

			const paths: string[] = [];
			const seenPaths = new Set<string>();
			for (const pathExpression of parsed.data.paths) {
				const resolved = resolveReviewedPathReference(
					pathExpression,
					toolContext,
				);
				if ("error" in resolved) {
					return toRejectedResult(resolved.error);
				}

				if (!seenPaths.has(resolved.reference)) {
					seenPaths.add(resolved.reference);
					paths.push(resolved.reference);
				}
			}

			summaryDrafts.changeAreas ??= [];
			summaryDrafts.changeAreas.push({
				title: parsed.data.title,
				paths,
				summary: parsed.data.summary,
			});
			return "Recorded the change area summary.";
		},
	});
}
