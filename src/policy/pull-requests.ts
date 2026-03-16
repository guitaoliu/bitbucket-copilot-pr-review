import type { PullRequestInfo } from "../bitbucket/types.ts";
import { REVIEWER_CONFIG_DEFAULTS } from "../config/defaults.ts";
import type { ReviewerConfig } from "../config/types.ts";

function buildEffectiveSkipBranchPrefixes(
	configuredPrefixes: ReviewerConfig["review"]["skipBranchPrefixes"],
): string[] {
	return [
		...new Set([
			...REVIEWER_CONFIG_DEFAULTS.review.skipBranchPrefixes,
			...configuredPrefixes,
		]),
	];
}

export function getPullRequestSkipReason(
	pullRequest: Pick<PullRequestInfo, "id" | "source" | "draft">,
	skipBranchPrefixes: ReviewerConfig["review"]["skipBranchPrefixes"],
): string | undefined {
	if (pullRequest.draft) {
		return `Skipping review because pull request #${pullRequest.id} is a draft.`;
	}

	for (const prefix of buildEffectiveSkipBranchPrefixes(skipBranchPrefixes)) {
		if (pullRequest.source.displayId.startsWith(prefix)) {
			return `Skipping review because pull request #${pullRequest.id} source branch ${pullRequest.source.displayId} matches skip prefix ${prefix}.`;
		}
	}

	return undefined;
}
