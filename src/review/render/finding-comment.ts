import type { ReviewableFile } from "../../git/types.ts";
import { buildFindingIdentities } from "../../policy/finding-identity.ts";
import type { ReviewFinding } from "../../policy/types.ts";
import type { FindingCommentDraft } from "../comment-sync.ts";
import {
	findingCommentKeys,
	formatFindingCodeMarker,
	formatFindingKeyMarker,
} from "../markers.ts";
import { formatFindingBadge, formatFindingLocation } from "./markdown.ts";

export function buildFindingCommentDrafts(
	tag: string,
	findings: readonly ReviewFinding[],
	reviewableFiles: readonly ReviewableFile[],
): FindingCommentDraft[] {
	return buildFindingIdentities(findings, reviewableFiles).map(
		({ finding, findingKey, codeKey }) => ({
			keys: findingCommentKeys(findingKey, finding),
			text: [
				formatFindingKeyMarker(tag, findingKey),
				formatFindingCodeMarker(tag, codeKey),
				`**${formatFindingBadge(finding)}**`,
				"",
				`**${finding.title}**`,
				"",
				`Location: \`${formatFindingLocation(finding)}\``,
				...(finding.details.trim().length > 0 ? ["", finding.details] : []),
			].join("\n"),
			...(finding.line > 0
				? { anchor: { path: finding.path, line: finding.line } }
				: {}),
		}),
	);
}
