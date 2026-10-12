import type {
	CommentRetirement,
	PullRequestCommentDraft,
} from "../../bitbucket/types.ts";
import { findingCommentKeys, formatFindingThreadMarker } from "../markers.ts";
import type { ReviewFinding } from "../types.ts";
import { formatFindingBadge, formatFindingLocation } from "./markdown.ts";

export const FINDING_COMMENT_RETIREMENT: CommentRetirement = {
	label: "stale pull request finding comment",
	supersededText:
		"_Superseded by a newer automated PR review finding. This thread is preserved because Bitbucket will not delete it._",
};

export function buildFindingCommentDraft(
	tag: string,
	finding: ReviewFinding,
): PullRequestCommentDraft {
	const text = [
		formatFindingThreadMarker(tag, finding.threadKey),
		`**${formatFindingBadge(finding)}**`,
		"",
		`**${finding.title}**`,
		"",
		`Location: \`${formatFindingLocation(finding)}\``,
		...(finding.details.trim().length > 0 ? ["", finding.details] : []),
	].join("\n");

	return {
		keys: findingCommentKeys(finding),
		text,
		...(finding.line > 0
			? { anchor: { path: finding.path, line: finding.line } }
			: {}),
	};
}
