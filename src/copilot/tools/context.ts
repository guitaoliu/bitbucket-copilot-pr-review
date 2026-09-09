import type { GitRepository } from "../../git/repo.ts";
import type { ChangedFile } from "../../git/types.ts";
import {
	type ChangedLineResolver,
	createChangedLineResolver,
} from "../../review/changed-lines.ts";
import { createReviewableFileLookup } from "../../review/file.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../../review/types.ts";
import type { Logger } from "../../shared/logger.ts";
import type { ReviewBundle } from "../review-bundle.ts";

export interface ReviewToolContext {
	context: ReviewContext;
	git: GitRepository;
	drafts: FindingDraft[];
	summaryDrafts: ReviewSummaryDrafts;
	reviewableFileMap: Map<string, ChangedFile>;
	resolveChangedLines: ChangedLineResolver;
	inspectionState: ReviewInspectionState;
	reviewBundle?: ReviewBundle;
	logger?: Logger;
}

export interface ReviewInspectionState {
	resultCharsByTool?: Partial<
		Record<
			"review_changes" | "read_file" | "search_repo" | "find_files",
			number
		>
	>;
	searchRepoMetrics?: {
		uniqueQueries: number;
		duplicateQueries: number;
		wholeRepoQueries: number;
		noMatchQueries: number;
	};
}

export function createReviewToolContext(
	context: ReviewContext,
	git: GitRepository,
	drafts: FindingDraft[],
	summaryDrafts: ReviewSummaryDrafts,
	inspectionState: ReviewInspectionState = {},
	logger?: Logger,
	reviewBundle?: ReviewBundle,
): ReviewToolContext {
	return {
		context,
		git,
		drafts,
		summaryDrafts,
		reviewableFileMap: createReviewableFileLookup(context.reviewableFiles),
		resolveChangedLines: createChangedLineResolver(context, git),
		inspectionState,
		...(reviewBundle ? { reviewBundle } : {}),
		...(logger ? { logger } : {}),
	};
}

export function recordInspectionResult(
	state: ReviewInspectionState,
	toolName: "review_changes" | "read_file" | "search_repo" | "find_files",
	result: string,
): void {
	state.resultCharsByTool ??= {};
	const metrics = state.resultCharsByTool;
	metrics[toolName] = (metrics[toolName] ?? 0) + result.length;
}
