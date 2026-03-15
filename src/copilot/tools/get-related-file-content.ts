import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { getRepoFileAccessDecision } from "../../policy/path-access.ts";
import {
	buildFileSliceResult,
	buildMissingPathResult,
	buildTextUnavailableResult,
	toRejectedResult,
	validateFileSliceRange,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const getRelatedFileContentArgsSchema = z
	.object({
		path: z.string().min(1),
		version: z.enum(["head", "base"]),
		startLine: z.number().int().min(1).optional(),
		endLine: z.number().int().min(1).optional(),
	})
	.strict();

export function createGetRelatedFileContentTool(
	toolContext: ReviewToolContext,
) {
	const { config, context, git } = toolContext;

	return defineTool("get_related_file_content", {
		description:
			"Read a safe repo-relative file outside the changed set for nearby architectural context.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: {
					type: "string",
					description: "Repo-relative file path at head or base.",
				},
				version: {
					type: "string",
					enum: ["head", "base"],
					description: "Which revision to read.",
				},
				startLine: {
					type: "integer",
					minimum: 1,
					description: "1-based start line.",
				},
				endLine: {
					type: "integer",
					minimum: 1,
					description: "1-based end line.",
				},
			},
			required: ["path", "version"],
		},
		handler: async (args: {
			path: string;
			version: "head" | "base";
			startLine?: number;
			endLine?: number;
		}) => {
			const parsedArgs = getRelatedFileContentArgsSchema.safeParse(args);
			if (!parsedArgs.success) {
				return toRejectedResult(
					`Invalid related-file payload: ${parsedArgs.error.message}`,
				);
			}

			const decision = getRepoFileAccessDecision(parsedArgs.data.path);
			if (!decision.include) {
				return toRejectedResult(
					`Related file access rejected: ${decision.reason}`,
				);
			}

			const rangeError = validateFileSliceRange(
				parsedArgs.data.startLine,
				parsedArgs.data.endLine,
			);
			if (rangeError) {
				return toRejectedResult(rangeError);
			}

			const commit =
				parsedArgs.data.version === "head"
					? context.headCommit
					: context.mergeBaseCommit;
			const content = await git.readTextFileAtCommit(
				commit,
				decision.normalizedPath,
			);
			if (content.status === "not_found") {
				return buildMissingPathResult(
					decision.normalizedPath,
					parsedArgs.data.version,
				);
			}

			if (content.status === "not_text") {
				return buildTextUnavailableResult(
					decision.normalizedPath,
					parsedArgs.data.version,
				);
			}

			if (content.status === "not_file") {
				return toRejectedResult(
					`Related file access rejected: ${decision.normalizedPath} is a directory, not a file.`,
				);
			}

			return buildFileSliceResult(
				content.content,
				decision.normalizedPath,
				parsedArgs.data.version,
				parsedArgs.data.startLine,
				parsedArgs.data.endLine,
				config.review,
			);
		},
	});
}
