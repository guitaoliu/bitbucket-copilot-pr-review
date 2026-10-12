import {
	findingDraftSchema,
	validateFindingLocation,
} from "../../policy/findings.ts";
import type { ReviewToolContext } from "./context.ts";
import { defineReviewTool, rejectToolCall } from "./define.ts";

export function createEmitFindingTool(toolContext: ReviewToolContext) {
	const { state, reviewedFiles } = toolContext;

	return defineReviewTool("emit_finding", {
		description:
			"Record a validated review finding for later publication to Bitbucket.",
		schema: findingDraftSchema,
		handler: async (finding) => {
			const location = validateFindingLocation(finding, reviewedFiles);
			if (!location.ok) {
				state.droppedFindings[location.reason] += 1;
				return rejectToolCall(location.message);
			}

			const { draft } = location;
			state.drafts.push(draft);
			const locationLabel = `${draft.path}:${draft.line > 0 ? draft.line : "file"}`;
			return location.note
				? `Recorded finding ${state.drafts.length} for ${locationLabel}; ${location.note}`
				: `Recorded finding ${state.drafts.length} for ${locationLabel}.`;
		},
	});
}
