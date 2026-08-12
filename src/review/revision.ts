import { createHash } from "node:crypto";

const REVIEW_REVISION_SCHEMA = "3";
const REVIEW_INPUT_VERSION = "2026-05-accuracy-stability-1";

export function getReviewRevisionSchema(): string {
	return REVIEW_REVISION_SCHEMA;
}

export function buildReviewRevision(input: {
	baseCommit: string;
	headCommit: string;
	mergeBaseCommit: string;
	ciSummary?: string;
	promptVersion?: string;
	copilot?: {
		model: string;
		reasoningEffort: string;
	};
	reviewConfig?: {
		minConfidence: string;
		maxPatchChars: number;
		defaultFileSliceLines: number;
		maxFileSliceLines: number;
		ignorePaths: readonly string[];
		skipBranchPrefixes: readonly string[];
	};
}): string {
	const payload = JSON.stringify({
		schema: REVIEW_REVISION_SCHEMA,
		inputVersion: REVIEW_INPUT_VERSION,
		baseCommit: input.baseCommit,
		headCommit: input.headCommit,
		mergeBaseCommit: input.mergeBaseCommit,
		...(input.ciSummary !== undefined ? { ciSummary: input.ciSummary } : {}),
		...(input.promptVersion !== undefined
			? { promptVersion: input.promptVersion }
			: {}),
		...(input.copilot !== undefined ? { copilot: input.copilot } : {}),
		...(input.reviewConfig !== undefined
			? { reviewConfig: input.reviewConfig }
			: {}),
	});

	return createHash("sha256").update(payload).digest("hex");
}
