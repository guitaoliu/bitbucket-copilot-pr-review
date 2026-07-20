import type { GitRepository } from "../../git/repo.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../../review/types.ts";
import { createReviewToolContext } from "./context.ts";
import { createEmitFindingTool } from "./emit-finding.ts";
import { createRecordChangeAreaSummaryTool } from "./record-change-area-summary.ts";
import { createRecordPrSummaryTool } from "./record-pr-summary.ts";

export const REVIEW_TOOL_NAMES = [
	"record_pr_summary",
	"record_change_area_summary",
	"emit_finding",
] as const;

export function createReviewTools(
	context: ReviewContext,
	git: GitRepository,
	drafts: FindingDraft[],
	summaryDrafts: ReviewSummaryDrafts,
) {
	const toolContext = createReviewToolContext(
		context,
		git,
		drafts,
		summaryDrafts,
	);

	return [
		createRecordPrSummaryTool(toolContext),
		createRecordChangeAreaSummaryTool(toolContext),
		createEmitFindingTool(toolContext),
	];
}
