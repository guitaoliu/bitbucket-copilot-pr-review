import type { ReviewerConfig } from "../../config/types.ts";
import type { GitRepository } from "../../git/repo.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../../review/types.ts";
import { createReviewToolContext } from "./context.ts";
import { createEmitFindingTool } from "./emit-finding.ts";
import { createGetCiSummaryTool } from "./get-ci-summary.ts";
import { createGetFileContentTool } from "./get-file-content.ts";
import { createGetFileDiffTool } from "./get-file-diff.ts";
import { createGetFileDiffHunkTool } from "./get-file-diff-hunk.ts";
import { createGetFileListByDirectoryTool } from "./get-file-list-by-directory.ts";
import { createGetPrOverviewTool } from "./get-pr-overview.ts";
import { createGetRelatedFileContentTool } from "./get-related-file-content.ts";
import { createGetRelatedTestsTool } from "./get-related-tests.ts";
import { createListChangedFilesTool } from "./list-changed-files.ts";
import { createListRecordedFindingsTool } from "./list-recorded-findings.ts";
import { createRecordFileSummaryTool } from "./record-file-summary.ts";
import { createRecordPrSummaryTool } from "./record-pr-summary.ts";
import { createRemoveRecordedFindingTool } from "./remove-recorded-finding.ts";
import { createReplaceRecordedFindingTool } from "./replace-recorded-finding.ts";
import { createSearchSymbolNameTool } from "./search-symbol-name.ts";
import { createSearchTextInRepoTool } from "./search-text-in-repo.ts";

export const REVIEW_TOOL_NAMES = [
	"get_pr_overview",
	"list_changed_files",
	"get_file_diff",
	"get_file_diff_hunk",
	"get_file_content",
	"get_file_list_by_directory",
	"get_related_file_content",
	"get_related_tests",
	"search_text_in_repo",
	"search_symbol_name",
	"get_ci_summary",
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
		createListChangedFilesTool(toolContext),
		createGetFileDiffTool(toolContext),
		createGetFileDiffHunkTool(toolContext),
		createGetFileContentTool(toolContext),
		createGetFileListByDirectoryTool(toolContext),
		createGetRelatedFileContentTool(toolContext),
		createGetRelatedTestsTool(toolContext),
		createSearchTextInRepoTool(toolContext),
		createSearchSymbolNameTool(toolContext),
		createGetCiSummaryTool(toolContext),
		createRecordPrSummaryTool(toolContext),
		createRecordFileSummaryTool(toolContext),
		createListRecordedFindingsTool(toolContext),
		createRemoveRecordedFindingTool(toolContext),
		createReplaceRecordedFindingTool(toolContext),
		createEmitFindingTool(toolContext),
	];
}
