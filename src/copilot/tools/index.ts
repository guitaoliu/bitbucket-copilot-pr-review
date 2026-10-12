import type { Tool } from "@github/copilot-sdk";

import { createReviewToolContext, type ReviewToolsOptions } from "./context.ts";
import type { ReviewToolCallObserver } from "./define.ts";
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

export const CONTEXT_TOOL_NAMES = [
	"read_file",
	"search_repo",
	"find_files",
] as const satisfies readonly (typeof REVIEW_TOOL_NAMES)[number][];

export function createReviewTools(
	options: ReviewToolsOptions & { toolCalls: ReviewToolCallObserver },
): Tool[] {
	const toolContext = createReviewToolContext(options);
	return [
		createReviewChangesTool(toolContext),
		createReadFileTool(toolContext),
		createSearchRepoTool(toolContext),
		createFindFilesTool(toolContext),
		createRecordPrSummaryTool(toolContext),
		createRecordChangeAreaSummaryTool(toolContext),
		createEmitFindingTool(toolContext),
	].map((definition) => definition.bind(options.toolCalls));
}
