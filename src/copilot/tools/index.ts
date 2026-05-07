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
import { createListRecordedFindingsTool } from "./list-recorded-findings.ts";
import { createRecordFileSummaryTool } from "./record-file-summary.ts";
import { createRecordPrSummaryTool } from "./record-pr-summary.ts";
import { createRemoveRecordedFindingTool } from "./remove-recorded-finding.ts";
import { createReplaceRecordedFindingTool } from "./replace-recorded-finding.ts";

export const REVIEW_TOOL_NAMES = [
	"get_pr_overview",
	"record_pr_summary",
	"record_file_summary",
	"list_recorded_findings",
	"remove_recorded_finding",
	"replace_recorded_finding",
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
		createRecordFileSummaryTool(toolContext),
		createListRecordedFindingsTool(toolContext),
		createRemoveRecordedFindingTool(toolContext),
		createReplaceRecordedFindingTool(toolContext),
		createEmitFindingTool(toolContext),
	];
}
