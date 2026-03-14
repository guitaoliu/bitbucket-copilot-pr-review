import { defineTool } from "@github/copilot-sdk";
import { toRejectedResult } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createRemoveRecordedFindingTool(
	toolContext: ReviewToolContext,
) {
	const { drafts } = toolContext;

	return defineTool("remove_recorded_finding", {
		description:
			"Remove a previously recorded finding draft that is duplicate, too weak, or superseded.",
		parameters: {
			type: "object",
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
			const findingIndex = args.findingNumber - 1;
			if (findingIndex < 0 || findingIndex >= drafts.length) {
				return toRejectedResult(
					`Finding ${args.findingNumber} does not exist. Recorded findings: ${drafts.length}.`,
				);
			}

			const removed = drafts.splice(findingIndex, 1)[0];
			if (!removed) {
				return toRejectedResult(
					`Finding ${args.findingNumber} could not be removed.`,
				);
			}

			return `Removed finding ${args.findingNumber} for ${removed.path}:${removed.line}. Remaining findings: ${drafts.length}.`;
		},
	});
}
