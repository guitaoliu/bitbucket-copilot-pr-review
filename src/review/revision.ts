import { createHash } from "node:crypto";

const REVIEW_REVISION_SCHEMA = "2";

export function getReviewRevisionSchema(): string {
	return REVIEW_REVISION_SCHEMA;
}

export function buildReviewRevision(input: {
	baseCommit: string;
	mergeBaseCommit: string;
	rawDiff: string;
}): string {
	const payload = JSON.stringify({
		schema: REVIEW_REVISION_SCHEMA,
		baseCommit: input.baseCommit,
		mergeBaseCommit: input.mergeBaseCommit,
		rawDiff: input.rawDiff,
	});

	return createHash("sha256").update(payload).digest("hex");
}
