import type { GitRepository } from "../../git/repo.ts";
import type { ReviewableFile } from "../../git/types.ts";
import {
	createReviewedFileLookup,
	type FindingRejectionReason,
} from "../../policy/findings.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../../review/types.ts";
import type { Logger } from "../../shared/logger.ts";
import type { ReviewBundle } from "../review-bundle.ts";

type InspectionToolName =
	| "review_changes"
	| "read_file"
	| "search_repo"
	| "find_files";

export interface ReviewInspectionState {
	resultCharsByTool: Partial<Record<InspectionToolName, number>>;
	searchRepoMetrics: {
		uniqueQueries: number;
		duplicateQueries: number;
		wholeRepoQueries: number;
		noMatchQueries: number;
	};
}

export interface ReviewToolState {
	drafts: FindingDraft[];
	droppedFindings: Record<FindingRejectionReason, number>;
	summaryDrafts: ReviewSummaryDrafts;
	inspection: ReviewInspectionState;
}

export interface ReviewToolsOptions {
	context: ReviewContext;
	git: GitRepository;
	logger: Logger;
	reviewBundle: ReviewBundle;
	state: ReviewToolState;
}

export interface ReviewToolContext extends ReviewToolsOptions {
	reviewedFiles: ReadonlyMap<string, ReviewableFile>;
}

export function createReviewToolState(): ReviewToolState {
	return {
		drafts: [],
		droppedFindings: { unknown_file: 0, unchanged_line: 0 },
		summaryDrafts: {},
		inspection: {
			resultCharsByTool: {},
			searchRepoMetrics: {
				uniqueQueries: 0,
				duplicateQueries: 0,
				wholeRepoQueries: 0,
				noMatchQueries: 0,
			},
		},
	};
}

export function createReviewToolContext(
	options: ReviewToolsOptions,
): ReviewToolContext {
	return {
		...options,
		reviewedFiles: createReviewedFileLookup(options.context.reviewableFiles),
	};
}

export function recordInspectionResult(
	state: ReviewInspectionState,
	toolName: InspectionToolName,
	result: string,
): void {
	state.resultCharsByTool[toolName] =
		(state.resultCharsByTool[toolName] ?? 0) + result.length;
}
