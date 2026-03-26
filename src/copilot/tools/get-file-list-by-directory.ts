import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { getRepoDirectoriesAccessDecision } from "../../policy/path-access.ts";
import {
	describeDirectoryScope,
	filterSafeRepoPaths,
	makeDirectoryPreview,
	toRejectedResult,
	validateDirectoryScopesAtCommit,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const getFileListByDirectoryArgsSchema = z
	.object({
		directories: z.array(z.string()).max(50).optional(),
		version: z.enum(["head", "base"]),
		limit: z.number().int().min(1).optional(),
	})
	.strict();

export function createGetFileListByDirectoryTool(
	toolContext: ReviewToolContext,
) {
	const { context, git } = toolContext;

	return defineTool("get_file_list_by_directory", {
		description:
			"List repo files under a safe directory at the head or base revision for architectural context.",
		skipPermission: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				directories: {
					type: "array",
					items: { type: "string" },
					description:
						"Repo-relative directories. Use ['.'] or omit for the repo root.",
				},
				version: {
					type: "string",
					enum: ["head", "base"],
					description: "Which revision to inspect.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 200,
					description: "Maximum number of paths to return.",
				},
			},
			required: ["version"],
		},
		handler: async (args: {
			directories?: string[];
			version: "head" | "base";
			limit?: number;
		}) => {
			const parsedArgs = getFileListByDirectoryArgsSchema.safeParse(args);
			if (!parsedArgs.success) {
				return toRejectedResult(
					`Invalid directory-list payload: ${parsedArgs.error.message}`,
				);
			}

			const decision = getRepoDirectoriesAccessDecision(
				parsedArgs.data.directories,
			);
			if (!decision.include) {
				return toRejectedResult(
					`Directory access rejected: ${decision.reason}`,
				);
			}

			const commit =
				parsedArgs.data.version === "head"
					? context.headCommit
					: context.mergeBaseCommit;
			const directoryValidation = await validateDirectoryScopesAtCommit(
				git,
				commit,
				decision.normalizedPaths,
			);
			if (directoryValidation.status === "not_found") {
				return toRejectedResult(
					`Directory access rejected: ${directoryValidation.path} is not present in the ${parsedArgs.data.version} revision.`,
				);
			}

			if (directoryValidation.status === "not_directory") {
				return toRejectedResult(
					`Directory access rejected: ${directoryValidation.path} is a file, not a directory.`,
				);
			}

			const files = await git.listFilesAtCommit(
				commit,
				decision.normalizedPaths,
			);
			const filtered = filterSafeRepoPaths(files.map((path) => ({ path })));
			const limit = Math.min(200, Math.max(1, parsedArgs.data.limit ?? 50));
			const preview = makeDirectoryPreview(
				filtered.entries.map((entry) => entry.path),
				limit,
			);

			return {
				directories: describeDirectoryScope(decision.normalizedPaths),
				version: parsedArgs.data.version,
				filteredFileCount: filtered.filteredCount,
				files: preview.files,
				truncated: preview.truncated || filtered.filteredCount > 0,
				totalFiles: preview.totalFiles,
			};
		},
	});
}
