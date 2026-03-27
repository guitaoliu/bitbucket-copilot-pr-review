import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";

export function getPullRequestSkipReason(
	pullRequest: Pick<PullRequestInfo, "id" | "source" | "draft">,
	skipBranchPrefixes: ReviewerConfig["review"]["skipBranchPrefixes"],
): string | undefined {
	if (pullRequest.draft) {
		return `Skipping review because pull request #${pullRequest.id} is a draft.`;
	}

	for (const prefix of skipBranchPrefixes) {
		if (pullRequest.source.displayId.startsWith(prefix)) {
			return `Skipping review because pull request #${pullRequest.id} source branch ${pullRequest.source.displayId} matches skip prefix ${prefix}.`;
		}
	}

	return undefined;
}
