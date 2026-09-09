import type { GitRepository } from "../../git/repo.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../../review/types.ts";
import type { Logger } from "../../shared/logger.ts";
import { ReviewBundle } from "../review-bundle.ts";
import type { ReviewInspectionState } from "./context.ts";
import { createReviewToolContext } from "./context.ts";
import { createEmitFindingTool } from "./emit-finding.ts";
import { createRecordChangeAreaSummaryTool } from "./record-change-area-summary.ts";
import { createRecordPrSummaryTool } from "./record-pr-summary.ts";
import {
	createFindFilesTool,
	createReadFileTool,
	createSearchRepoTool,
} from "./repository-context.ts";
import { createReviewChangesTool } from "./review-changes.ts";

export const REVIEW_TOOL_NAMES = [
	"review_changes",
	"read_file",
	"search_repo",
	"find_files",
	"record_pr_summary",
	"record_change_area_summary",
	"emit_finding",
] as const;

export function createReviewTools(
	context: ReviewContext,
	git: GitRepository,
	drafts: FindingDraft[],
	summaryDrafts: ReviewSummaryDrafts,
	inspectionState: ReviewInspectionState = {},
	logger?: Logger,
	reviewBundle = new ReviewBundle(context, git),
) {
	const toolContext = createReviewToolContext(
		context,
		git,
		drafts,
		summaryDrafts,
		inspectionState,
		logger,
		reviewBundle,
	);

	return [
		createReviewChangesTool(toolContext),
		createReadFileTool(toolContext),
		createSearchRepoTool(toolContext),
		createFindFilesTool(toolContext),
		createRecordPrSummaryTool(toolContext),
		createRecordChangeAreaSummaryTool(toolContext),
		createEmitFindingTool(toolContext),
	];
}
