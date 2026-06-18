import type { ReviewerConfig } from "../../config/types.ts";
import type { GitRepository } from "../../git/repo.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../../review/types.ts";
import { createReviewToolContext } from "./context.ts";
import { createEmitFindingTool } from "./emit-finding.ts";
import { createGetPrOverviewTool } from "./get-pr-overview.ts";
import { createRecordChangeAreaSummaryTool } from "./record-change-area-summary.ts";
import { createRecordPrSummaryTool } from "./record-pr-summary.ts";

export const REVIEW_TOOL_NAMES = [
	"get_pr_overview",
	"record_pr_summary",
	"record_change_area_summary",
	"emit_finding",
] as const;

export function createReviewTools(
	config: ReviewerConfig,
	context: ReviewContext,
	git: GitRepository,
	drafts: FindingDraft[],
	summaryDrafts: ReviewSummaryDrafts,
) {
	const toolContext = createReviewToolContext(
		config,
		context,
		git,
		drafts,
		summaryDrafts,
	);

	return [
		createGetPrOverviewTool(toolContext),
		createRecordPrSummaryTool(toolContext),
		createRecordChangeAreaSummaryTool(toolContext),
		createEmitFindingTool(toolContext),
	];
}
