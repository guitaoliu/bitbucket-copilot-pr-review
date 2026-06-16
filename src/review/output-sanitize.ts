import { omitUndefined } from "../shared/object.ts";
import { sanitizeModelAuthoredText } from "../shared/text.ts";
import type { ReviewFinding, ReviewOutcome } from "./types.ts";

function sanitizeReviewFindingForOutput(finding: ReviewFinding): ReviewFinding {
	return omitUndefined({
		...finding,
		title: sanitizeModelAuthoredText(finding.title),
		details: sanitizeModelAuthoredText(finding.details),
		category: finding.category
			? sanitizeModelAuthoredText(finding.category)
			: undefined,
	}) satisfies ReviewFinding;
}

export function sanitizeReviewOutcomeForOutput(
	outcome: ReviewOutcome,
): ReviewOutcome {
	return omitUndefined({
		...outcome,
		summary: sanitizeModelAuthoredText(outcome.summary),
		findings: outcome.findings.map(sanitizeReviewFindingForOutput),
		...(outcome.assistantMessage
			? {
					assistantMessage: sanitizeModelAuthoredText(outcome.assistantMessage),
				}
			: {}),
		...(outcome.prSummary
			? { prSummary: sanitizeModelAuthoredText(outcome.prSummary) }
			: {}),
		...(outcome.fileSummaries
			? {
					fileSummaries: outcome.fileSummaries.map((entry) => ({
						...entry,
						summary: sanitizeModelAuthoredText(entry.summary),
					})),
				}
			: {}),
	}) satisfies ReviewOutcome;
}
