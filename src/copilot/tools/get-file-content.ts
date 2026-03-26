import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { getReviewedFilePathForVersion } from "../../review/file.ts";
import {
	buildFileSliceResult,
	buildMissingPathResult,
	buildTextUnavailableResult,
	toRejectedResult,
	validateFileSliceRange,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const getFileContentArgsSchema = z
	.object({
		path: z.string().min(1),
		version: z.enum(["head", "base"]),
		startLine: z.number().int().min(1).optional(),
		endLine: z.number().int().min(1).optional(),
	})
	.strict();

export function createGetFileContentTool(toolContext: ReviewToolContext) {
	const { config, context, git, reviewedFileMap } = toolContext;

	return defineTool("get_file_content", {
		description:
			"Get head or base file contents with line numbers for a reviewed file.",
		skipPermission: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string", description: "Path of the reviewed file." },
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
			const parsedArgs = getFileContentArgsSchema.safeParse(args);
			if (!parsedArgs.success) {
				return toRejectedResult(
					`Invalid file-content payload: ${parsedArgs.error.message}`,
				);
			}

			const file = reviewedFileMap.get(parsedArgs.data.path);
			if (!file) {
				return toRejectedResult(
					`The file ${parsedArgs.data.path} is not available for review. Use list_changed_files first.`,
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
			const filePath = getReviewedFilePathForVersion(
				file,
				parsedArgs.data.version,
			);
			const content = await git.readTextFileAtCommit(commit, filePath);
			if (content.status === "not_found") {
				return buildMissingPathResult(filePath, parsedArgs.data.version);
			}

			if (content.status === "not_text") {
				return buildTextUnavailableResult(filePath, parsedArgs.data.version);
			}

			if (content.status !== "ok") {
				return toRejectedResult(
					`The path ${filePath} is not a readable file in the ${parsedArgs.data.version} revision.`,
				);
			}

			return buildFileSliceResult(
				content.content,
				filePath,
				parsedArgs.data.version,
				parsedArgs.data.startLine,
				parsedArgs.data.endLine,
				config.review,
			);
		},
	});
}
