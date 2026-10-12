import type {
	InsightReportDataField,
	InsightReportPayload,
} from "../bitbucket/types.ts";
import { omitUndefined } from "../shared/object.ts";

const FINDINGS_FIELD_TITLE = "Findings";
const REVIEW_REVISION_FIELD_TITLE = "Review revision";

export interface PublishedReportState {
	revision?: string;
	findingCount?: number;
}

export function buildPublicationStateFields(options: {
	revision: string;
	findingCount: number;
}): InsightReportDataField[] {
	return [
		{
			title: FINDINGS_FIELD_TITLE,
			type: "NUMBER",
			value: options.findingCount,
		},
		{
			title: REVIEW_REVISION_FIELD_TITLE,
			type: "TEXT",
			value: options.revision,
		},
	];
}

function parseFindingCount(
	value: InsightReportDataField["value"] | undefined,
): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Number.parseInt(value.trim(), 10);
	}

	return undefined;
}

export function readPublishedReportState(
	report: Pick<InsightReportPayload, "data">,
): PublishedReportState {
	const fieldValue = (title: string) =>
		report.data?.find((entry) => entry.title === title)?.value;
	const revision = fieldValue(REVIEW_REVISION_FIELD_TITLE);

	return omitUndefined({
		revision:
			typeof revision === "string" && revision.trim().length > 0
				? revision.trim()
				: undefined,
		findingCount: parseFindingCount(fieldValue(FINDINGS_FIELD_TITLE)),
	}) satisfies PublishedReportState;
}
