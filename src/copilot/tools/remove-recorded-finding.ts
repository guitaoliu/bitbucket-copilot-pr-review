import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { parseObjectToolArgs, toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const removeRecordedFindingArgsSchema = z
	.object({
		findingNumber: z.number().int().min(1),
	})
	.strict();

export function createRemoveRecordedFindingTool(
	toolContext: ReviewToolContext,
) {
	const { drafts } = toolContext;

	return defineTool("remove_recorded_finding", {
		description:
			"Remove a previously recorded finding draft that is duplicate, too weak, or superseded.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				findingNumber: {
					type: "integer",
					minimum: 1,
					description: "1-based finding number from list_recorded_findings.",
				},
			},
			required: ["findingNumber"],
		},
		handler: async (args: { findingNumber: number }) => {
			const parsedArgs = parseObjectToolArgs(
				args,
				removeRecordedFindingArgsSchema,
				"Invalid remove-finding payload",
			);
			if (parsedArgs.rejection) {
				return parsedArgs.rejection;
			}
			const parsedData = parsedArgs.data;
			if (!parsedData) {
				return toRejectedResult(
					"Invalid remove-finding payload: expected an object payload.",
				);
			}

			const findingIndex = parsedData.findingNumber - 1;
			if (findingIndex < 0 || findingIndex >= drafts.length) {
				return toRejectedResult(
					`Finding ${parsedData.findingNumber} does not exist. Recorded findings: ${drafts.length}.`,
				);
			}

			const removed = drafts.splice(findingIndex, 1)[0];
			if (!removed) {
				return toRejectedResult(
					`Finding ${parsedData.findingNumber} could not be removed.`,
				);
			}

			return `Removed finding ${parsedData.findingNumber} for ${removed.path}:${removed.line}. Remaining findings: ${drafts.length}.`;
		},
	});
}
