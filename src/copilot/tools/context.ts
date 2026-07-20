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

export interface ReviewToolContext {
	context: ReviewContext;
	drafts: FindingDraft[];
	summaryDrafts: ReviewSummaryDrafts;
	reviewableFileMap: Map<string, ChangedFile>;
	resolveChangedLines: ChangedLineResolver;
}

export function createReviewToolContext(
	context: ReviewContext,
	git: GitRepository,
	drafts: FindingDraft[],
	summaryDrafts: ReviewSummaryDrafts,
): ReviewToolContext {
	return {
		context,
		drafts,
		summaryDrafts,
		reviewableFileMap: createReviewableFileLookup(context.reviewableFiles),
		resolveChangedLines: createChangedLineResolver(context, git),
	};
}
