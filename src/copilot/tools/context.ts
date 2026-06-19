import type { ReviewerConfig } from "../../config/types.ts";
import type { GitRepository } from "../../git/repo.ts";
import type { ChangedFile } from "../../git/types.ts";
import {
	type ChangedLineResolver,
	createChangedLineResolver,
} from "../../review/changed-lines.ts";
import { createReviewedFileLookup } from "../../review/file.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../../review/types.ts";

export interface ReviewToolContext {
	config: ReviewerConfig;
	context: ReviewContext;
	git: GitRepository;
	drafts: FindingDraft[];
	summaryDrafts: ReviewSummaryDrafts;
	reviewedFileMap: Map<string, ChangedFile>;
	resolveChangedLines: ChangedLineResolver;
}

export function createReviewToolContext(
	config: ReviewerConfig,
	context: ReviewContext,
	git: GitRepository,
	drafts: FindingDraft[],
	summaryDrafts: ReviewSummaryDrafts,
): ReviewToolContext {
	return {
		config,
		context,
		git,
		drafts,
		summaryDrafts,
		reviewedFileMap: createReviewedFileLookup(context.reviewedFiles),
		resolveChangedLines: createChangedLineResolver(context, git),
	};
}
