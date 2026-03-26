import { defineTool } from "@github/copilot-sdk";

import type { ReviewToolContext } from "./context.ts";

export function createListRecordedFindingsTool(toolContext: ReviewToolContext) {
	const { drafts } = toolContext;

	return defineTool("list_recorded_findings", {
		description:
			"List the currently recorded finding drafts so the reviewer can avoid duplicates or replace weaker findings.",
		skipPermission: true,
		handler: async () => ({
			count: drafts.length,
			findings: drafts.map((draft, index) => ({
				findingNumber: index + 1,
				...draft,
			})),
		}),
	});
}
